import { resampleToMono, monoToStereo } from '../agent/audio.util';
import { PlayoutDrain } from './playout-drain';

// Discord voice is always 48kHz stereo s16le.
const RATE = 48000;
const CHANNELS = 2;
const FRAME_SAMPLES = 960; // 20ms @ 48kHz
const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2; // 20ms @ 48kHz stereo s16le
const SILENCE = Buffer.alloc(FRAME_BYTES);
// The Qwen3-TTS server emits 24kHz mono (verified from its WAV header). write() resamples 24k->48k and
// duplicates to stereo for Discord. Keep in sync with the TTS model if you swap to one at another rate.
const TTS_RATE = 24000;
// So outBuf legitimately holds seconds of pending audio: cap only as a runaway backstop — a normal reply
// is cleared per turn / on barge. (A tight cap here truncated the START of the reply.)
const MAX_OUT = FRAME_BYTES * 50 * 30; // ~30s backstop
// Two-tier buffering (LiveKit's jitter buffer used to do this for us). Buffer REAL audio up to CUSHION;
// fill SILENCE only to a shallow FLOOR so idle gaps don't pile silence ahead of the next reply and
// inflate onset latency. CUSHION only has to ride out Node timer jitter on the playout pacer now: under
// whole-reply synthesis + server RTF < 1, the whole reply lands in outBuf faster than realtime, so a
// mid-stream TTS stall can't starve playout. CUSHION is the jitter <-> latency knob: raise it if replies
// underrun, lower it if onset feels laggy. Go back to a deep lead (~12 frames) only if you return to
// sentence-streaming, where a generation stall mid-reply is real again.
const CUSHION = FRAME_BYTES * 3; // ~60ms real-audio lead (3 frames) — covers timer jitter, not a stall
const FLOOR = FRAME_BYTES * 2; // ~40ms silence floor to keep the player from latching idle
// Startup prime for streaming synthesis (approach B): hold playout until this much real audio has
// accumulated, so a producer that lags realtime early (the LLM ramping up, server pause-don't-pad) builds
// a backlog instead of underrunning into gaps. The onset<->gap knob: raise if the start still gaps, lower
// if onset feels laggy. ~400ms. Whole-reply synth (approach C) hits this instantly, so it's a no-op there;
// flush() releases it for a reply shorter than the prime.
export const STARTUP_PRIME_BYTES = FRAME_BYTES * 20;

// The output port the pacer drives: the real pcmOut Readable, or a fake in tests. Exposes only what the
// pacer touches — bytes currently queued for playback, and a push to enqueue one frame.
export interface PlayoutPort {
  readableLength: number;
  push(buf: Buffer): void;
}

// Owns the agent->Discord output path: the pending-PCM buffer (outBuf) and the realtime playout pacer,
// plus the slice-6 drain signal. The agent dumps a whole reply into outBuf faster than realtime via
// write(); pump() drains it at realtime into an injected output port, keeping a small cushion of real
// audio and a silence floor so the player never latches idle. Pure state + arithmetic against an
// injected port — no Discord I/O — so the interface is the test surface (modeled on SpeakerMixer).
export class VoicePlayout {
  private outBuf = Buffer.alloc(0); // assistant PCM awaiting playout
  private readonly drain = new PlayoutDrain();
  private primed = false; // startup prime gate (per reply); see STARTUP_PRIME_BYTES

  // primeBytes>0 holds playout until that backlog accumulates (streaming startup); 0 = drain immediately
  // (whole-reply path / tests). Reset per reply by clear(); released early by flush().
  constructor(private readonly primeBytes = 0) {}

  // The agent writes 24kHz mono reply chunks here; resample to Discord's 48kHz stereo and append. pump()
  // re-slices outBuf into exact 20ms frames, so chunks need no framing of their own.
  write(pcm: Int16Array): void {
    const stereo = Buffer.copyBytesFrom(
      monoToStereo(resampleToMono(pcm, TTS_RATE, 1, RATE)),
    );
    this.outBuf = this.outBuf.length ? Buffer.concat([this.outBuf, stereo]) : stereo;
    if (this.outBuf.length > MAX_OUT)
      this.outBuf = this.outBuf.subarray(this.outBuf.length - MAX_OUT);
  }

  // Barge/teardown: drop queued audio. Playout is drained by definition once the queue is empty, so
  // release the drain gate (a cut reply must never strand the detector suppressed).
  clear(): void {
    this.outBuf = Buffer.alloc(0);
    this.primed = false; // re-prime the next reply
    this.drain.clear();
  }

  // The reply's synthesis is complete: release the startup prime so a reply shorter than primeBytes still
  // plays out (instead of being held forever waiting for a backlog that will never arrive).
  flush(): void {
    this.primed = true;
  }

  // Resolves once the tail has actually played out (outBuf empty + no real frames left in the player),
  // and on clear()/close() so the agent's drain gate is never left hanging.
  whenDrained(): Promise<void> {
    return this.drain.whenDrained();
  }

  // Session teardown: the pacer is about to stop; resolve any pending/future drain gate so the detector
  // isn't stranded suppressed (deaf) after teardown — fail-open.
  close(): void {
    this.drain.close();
  }

  // Bytes of assistant PCM still queued (test/diagnostic surface; not a frame count).
  pendingBytes(): number {
    return this.outBuf.length;
  }

  // One pacer step against the injected port. Buffer REAL audio up to CUSHION; fill SILENCE only to the
  // shallow FLOOR. Then signal drain: real assistant audio is still pending iff outBuf holds at least one
  // more real frame, OR the player still has real frames queued above the silence floor. Once both are
  // false, only the silence floor remains — the tail has played out, so release the detector.
  pump(out: PlayoutPort): void {
    // Startup prime: until the backlog reaches primeBytes (or flush()/clear() flips it), emit only the
    // silence floor — don't start real playout — so the early ramp doesn't underrun into gaps. primeBytes=0
    // primes on the first tick (no hold).
    if (!this.primed && this.outBuf.length >= this.primeBytes) this.primed = true;
    if (this.primed) {
      while (out.readableLength < CUSHION && this.outBuf.length >= FRAME_BYTES) {
        out.push(this.outBuf.subarray(0, FRAME_BYTES));
        this.outBuf = this.outBuf.subarray(FRAME_BYTES);
      }
    }
    while (out.readableLength < FLOOR) {
      out.push(SILENCE);
    }
    this.drain.update(this.outBuf.length >= FRAME_BYTES || out.readableLength > FLOOR);
  }
}
