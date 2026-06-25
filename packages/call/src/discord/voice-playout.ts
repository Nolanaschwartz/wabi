import { resampleToMono, monoToStereo } from '../agent/audio.util';

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
  // Drain signal for barge-in during the playout tail (slice 6): TTS runs faster than realtime, so the
  // agent finishes RECEIVING a reply while we keep PLAYING its tail out of outBuf. The detector must stay
  // suppressed for that whole tail, gating un-suppress on whenDrained(). FAIL-OPEN is the point — a missed
  // signal that leaves the detector deaf is worse than re-opening early — so whenDrained() always resolves:
  // on real drain, and immediately once torn down. The agent layers a safety timeout on top.
  private waiters: Array<() => void> = []; // gates awaiting drain
  private closed = false; // true once torn down: every future whenDrained() resolves at once

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
  // release the drain gate (a cut reply must never strand the detector suppressed). Future whenDrained()
  // calls (a fresh reply's gate) start waiting again.
  clear(): void {
    this.outBuf = Buffer.alloc(0);
    this.flushWaiters();
  }

  // Resolves once the tail has actually played out (outBuf empty + no real frames left in the player),
  // and on clear()/close() so the agent's drain gate is never left hanging. If already torn down, resolves
  // immediately. Never rejects — fail-open.
  whenDrained(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  // Session teardown: the pacer is about to stop; from here every whenDrained() resolves immediately so a
  // gate armed during shutdown can never strand the detector suppressed (deaf) — fail-open.
  close(): void {
    this.closed = true;
    this.flushWaiters();
  }

  private flushWaiters(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const resolve of w) resolve();
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
    while (out.readableLength < CUSHION && this.outBuf.length >= FRAME_BYTES) {
      out.push(this.outBuf.subarray(0, FRAME_BYTES));
      this.outBuf = this.outBuf.subarray(FRAME_BYTES);
    }
    while (out.readableLength < FLOOR) {
      out.push(SILENCE);
    }
    // Real assistant audio is still pending iff outBuf holds at least one more real frame, OR the player
    // still has real frames queued above the silence floor. Once both are false, only the silence floor
    // remains — the tail has played out, so release any waiting drain gate.
    const pendingReal = this.outBuf.length >= FRAME_BYTES || out.readableLength > FLOOR;
    if (!pendingReal) this.flushWaiters();
  }
}
