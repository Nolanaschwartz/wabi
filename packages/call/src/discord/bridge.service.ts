import { Injectable, Logger } from '@nestjs/common';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  NoSubscriberBehavior,
  EndBehaviorType,
} from '@discordjs/voice';
import { VoiceBasedChannel } from 'discord.js';
import { Readable } from 'node:stream';
import * as prism from 'prism-media';
import { VoiceAgentService, ReplySink } from '../agent/voice-agent.service';
import { resampleToMono, monoToStereo } from '../agent/audio.util';
import { SpeakerMixer } from './speaker-mixer';
import { PlayoutDrain } from './playout-drain';

// Discord voice is always 48kHz stereo s16le.
const RATE = 48000;
const CHANNELS = 2;
const FRAME_SAMPLES = 960; // 20ms @ 48kHz
// The Qwen3-TTS server emits 24kHz mono (verified from its WAV header). outSink resamples 24k->48k and
// duplicates to stereo for Discord. Keep in sync with TTS_MODEL if you swap to a model at another rate.
const TTS_RATE = 24000;

@Injectable()
export class DiscordBridge {
  private readonly log = new Logger(DiscordBridge.name);
  private readonly sessions = new Map<string, () => void>(); // guildId -> cleanup
  private readonly outs = new Map<string, Readable>(); // guildId -> Discord PCM sink

  constructor(private readonly agent: VoiceAgentService) {}

  // Diagnostic: push 1s of 440Hz tone straight into the Discord player, bypassing the agent/TTS.
  // If you hear this but not the assistant, the Discord transmit path is fine and the issue is upstream.
  playTone(guildId: string): boolean {
    const pcmOut = this.outs.get(guildId);
    if (!pcmOut) return false;
    const n = RATE; // 1 second
    const buf = Buffer.alloc(n * CHANNELS * 2);
    for (let i = 0; i < n; i++) {
      const s = Math.round(Math.sin((2 * Math.PI * 440 * i) / RATE) * 8000);
      for (let c = 0; c < CHANNELS; c++)
        buf.writeInt16LE(s, (i * CHANNELS + c) * 2);
    }
    pcmOut.push(buf);
    this.log.log(`pushed 1s test tone to Discord (guild ${guildId})`);
    return true;
  }

  // memoryBlock: recalled facts for the agent's system prompt; '' = plain assistant.
  async start(channel: VoiceBasedChannel, memoryBlock = ''): Promise<void> {
    const guildId = channel.guild.id;
    this.stop(guildId); // ponytail: one bridge per guild; restart replaces it

    // --- Discord: join the voice channel ---
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, // must hear to forward audio
    });
    connection.on('stateChange', (o, n) =>
      this.log.log(`voice connection ${o.status} -> ${n.status}`),
    );
    connection.on('error', (e) =>
      this.log.error(`voice connection error: ${e.message}`),
    );

    let closed = false; // set on hangup; stops captures/forwarding mid-stream

    // --- agent -> Discord (set up first so outBuf exists before the agent starts) ---
    // The agent dumps a whole reply into outBuf faster than realtime; the pacer below drains it at
    // realtime into the player, keeping a small cushion and emitting silence only on a genuine underrun
    // (so the player never latches to idle and drops audio).
    const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2; // 20ms @ 48kHz stereo s16le
    const SILENCE = Buffer.alloc(FRAME_BYTES);
    // So outBuf legitimately holds seconds of pending audio: cap only as a runaway backstop — a normal
    // reply is cleared per turn / on barge. (A tight cap here truncated the START of the reply.)
    const MAX_OUT = FRAME_BYTES * 50 * 30; // ~30s backstop
    let outBuf = Buffer.alloc(0); // assistant PCM awaiting playout
    const pcmOut = new Readable({ read() {} });
    this.outs.set(guildId, pcmOut);

    // DIAGNOSTIC: per-reply playout rate vs what the TTS server sent. realFrames = audio the server
    // produced (should match the agent's synth_audio); wall span of those frames = how long it actually
    // took to play. stretch = wall/real (1.0 = plays at the server's rate; >1 = dragging). gapSilence =
    // silence the pacer injected *between* real frames (mid-reply underruns) — the buffer's contribution
    // to drag. Trailing idle silence after the reply is excluded. Logged per reply at clear()/teardown.
    const FRAME_SEC = FRAME_SAMPLES / RATE; // 0.02s
    let pReal = 0; // real frames played this reply
    let pGapSilence = 0; // silence frames counted as mid-reply underruns
    let pPendSilence = 0; // silence since the last real frame (becomes gap only if more real audio follows)
    let pT0 = 0; // wall time of first real frame
    let pTLast = 0; // wall time of last real frame
    const logPlayout = () => {
      if (pReal === 0) return;
      const realSec = pReal * FRAME_SEC;
      const wallSec = (pTLast - pT0) / 1000 + FRAME_SEC;
      this.log.log(
        `playout: server=${realSec.toFixed(2)}s played=${wallSec.toFixed(2)}s ` +
          `stretch=${(wallSec / realSec).toFixed(2)} gap_silence=${(pGapSilence * FRAME_SEC).toFixed(2)}s`,
      );
      pReal = 0;
      pGapSilence = 0;
      pPendSilence = 0;
      pT0 = 0;
      pTLast = 0;
    };

    // Drain signal for slice 6 (barge-in playout tail). Owns its own state — deliberately NOT derived
    // from the `logPlayout` diagnostic counters above, which a later cleanup slice removes. The pacer
    // below calls drain.update() each tick; the agent gates setSuppressed(false) on whenDrained().
    const drain = new PlayoutDrain();

    // The agent writes 24kHz mono reply chunks here; resample to Discord's 48kHz stereo and append. The
    // pacer below re-slices outBuf into exact 20ms frames, so chunks need no framing of their own.
    const outSink: ReplySink = {
      write: (pcm) => {
        if (closed) return;
        const stereo = Buffer.copyBytesFrom(monoToStereo(resampleToMono(pcm, TTS_RATE, 1, RATE)));
        outBuf = outBuf.length ? Buffer.concat([outBuf, stereo]) : stereo;
        if (outBuf.length > MAX_OUT) outBuf = outBuf.subarray(outBuf.length - MAX_OUT);
      },
      clear: () => {
        logPlayout(); // a new reply is starting (or a barge cut this one) — report the one that just played
        outBuf = Buffer.alloc(0);
        drain.clear(); // queued audio just dropped — playout is drained by definition; release the gate
      },
      // Resolves once the tail has actually played out (outBuf empty + no real frames left in the
      // player), and on barge/teardown so the agent's drain gate is never left hanging.
      whenDrained: () => drain.whenDrained(),
    };
    await this.agent.start(guildId, outSink, memoryBlock);

    // NoSubscriberBehavior.Play: keep playing in the brief window before the voice connection is ready,
    // so the resource isn't torn down to idle during startup.
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });
    player.on('error', (e) =>
      this.log.error(`discord player error: ${e.message}`),
    );
    player.on('stateChange', (o, n) =>
      this.log.log(`discord player ${o.status} -> ${n.status}`),
    );
    player.play(createAudioResource(pcmOut, { inputType: StreamType.Raw }));
    connection.subscribe(player);

    // Two-tier buffering (LiveKit's jitter buffer used to do this for us). Buffer REAL audio up to
    // CUSHION; fill SILENCE only to a shallow FLOOR so idle gaps don't pile silence ahead of the next
    // reply and inflate onset latency. CUSHION only has to ride out Node timer jitter on the playout
    // pacer now: under whole-reply synthesis + server RTF < 1, the whole reply lands in outBuf faster
    // than realtime, so a mid-stream TTS stall can't starve playout (the old reason for a deep lead).
    // CUSHION is the jitter <-> latency knob: raise it if replies underrun, lower it if onset feels
    // laggy. Go back to a deep lead (~12 frames) only if you return to sentence-streaming, where a
    // generation stall mid-reply is real again. A sub-frame remainder stays in outBuf for a later chunk.
    const CUSHION = FRAME_BYTES * 6; // ~60ms real-audio lead — covers timer jitter, not a stream stall
    const FLOOR = FRAME_BYTES * 2; // ~40ms silence floor to keep the player from latching idle
    const paceTimer = setInterval(() => {
      if (closed) return;
      while (pcmOut.readableLength < CUSHION && outBuf.length >= FRAME_BYTES) {
        pcmOut.push(outBuf.subarray(0, FRAME_BYTES));
        outBuf = outBuf.subarray(FRAME_BYTES);
        const now = Date.now();
        if (pReal === 0) pT0 = now;
        pGapSilence += pPendSilence; // silence that turned out to sit between real frames = a mid-reply gap
        pPendSilence = 0;
        pReal++;
        pTLast = now;
      }
      while (pcmOut.readableLength < FLOOR) {
        pcmOut.push(SILENCE);
        if (pReal > 0) pPendSilence++; // only after playout started; trailing idle silence is dropped at log
      }
      // Drain check (slice 6): real assistant audio is still pending iff outBuf holds at least one more
      // real frame, OR the player still has real frames queued above the silence floor. Once both are
      // false, only the silence floor remains — the tail has played out, so release the detector.
      drain.update(outBuf.length >= FRAME_BYTES || pcmOut.readableLength > FLOOR);
    }, 10);

    // --- Discord -> agent: decode each speaker separately and feed the mixer, which combines
    // simultaneous talkers into one steady 48kHz stereo stream. ---
    const FRAME_LEN = FRAME_SAMPLES * CHANNELS; // int16s per 20ms frame (960 * 2)
    const mixer = new SpeakerMixer(FRAME_LEN);
    const subscribed = new Set<string>(); // opus-stream dedup (a transport concern)

    connection.receiver.speaking.on('start', (userId) => {
      if (subscribed.has(userId)) return;
      subscribed.add(userId);
      const opus = connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
      });
      const decoder = new prism.opus.Decoder({
        rate: RATE,
        channels: CHANNELS,
        frameSize: FRAME_SAMPLES,
      });
      opus.pipe(decoder);
      decoder.on('data', (pcm: Buffer) => {
        if (closed) return;
        const frame = new Int16Array(FRAME_LEN); // fresh offset-0 buffer (copy)
        frame.set(
          new Int16Array(
            pcm.buffer,
            pcm.byteOffset,
            Math.min(pcm.length / 2, FRAME_LEN),
          ),
        );
        mixer.feed(userId, frame);
      });
      decoder.on('error', (e) => this.log.warn(`decoder: ${e.message}`));
      opus.on('end', () => {
        subscribed.delete(userId);
        mixer.drop(userId); // stops after 1s silence; re-added on next 'start'
      });
    });

    // Mixer tick: every 20ms pull one mixed frame and feed it to the agent's turn detector.
    // ponytail: setInterval clock; jitter is absorbed by the detector's frame buffer.
    const mixTimer = setInterval(() => {
      if (closed) return;
      const mixed = mixer.tick();
      if (mixed) this.agent.feed(guildId, mixed, RATE, CHANNELS);
    }, 20);

    this.log.log(`bridge up: #${channel.name} <-> agent (guild ${guildId})`);
    this.sessions.set(guildId, () => {
      closed = true; // stop captures/forwarding before tearing down
      logPlayout(); // report the final reply (no clear() follows it)
      drain.close(); // pacer is about to stop; resolve any pending/future drain gate so the detector
      //                isn't stranded suppressed (deaf) after teardown — fail-open
      clearInterval(mixTimer);
      clearInterval(paceTimer);
      this.agent.stop(guildId);
      try {
        connection.destroy();
      } catch {}
      pcmOut.push(null);
      this.outs.delete(guildId);
    });
  }

  stop(guildId: string) {
    const cleanup = this.sessions.get(guildId);
    if (cleanup) {
      cleanup();
      this.sessions.delete(guildId);
      this.log.log(`bridge down: guild ${guildId}`);
    }
  }
}
