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

    // Drain signal for slice 6 (barge-in playout tail). The pacer below calls drain.update() each tick;
    // the agent gates setSuppressed(false) on whenDrained() so the detector stays suppressed through the
    // tail. clear()/teardown release it so the gate is never left hanging.
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
    const CUSHION = FRAME_BYTES * 3; // ~60ms real-audio lead (3 frames) — covers timer jitter, not a stall
    const FLOOR = FRAME_BYTES * 2; // ~40ms silence floor to keep the player from latching idle
    const paceTimer = setInterval(() => {
      if (closed) return;
      while (pcmOut.readableLength < CUSHION && outBuf.length >= FRAME_BYTES) {
        pcmOut.push(outBuf.subarray(0, FRAME_BYTES));
        outBuf = outBuf.subarray(FRAME_BYTES);
      }
      while (pcmOut.readableLength < FLOOR) {
        pcmOut.push(SILENCE);
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
    // Track live decode streams so teardown can destroy them deterministically rather than relying on
    // connection.destroy() cascading (a mid-stream prism decoder can otherwise linger).
    const decoders = new Map<string, { opus: { destroy(): void }; decoder: { destroy(): void } }>();

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
      decoders.set(userId, { opus, decoder });
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
        decoders.delete(userId); // ended naturally; nothing to destroy
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
      drain.close(); // pacer is about to stop; resolve any pending/future drain gate so the detector
      //                isn't stranded suppressed (deaf) after teardown — fail-open
      clearInterval(mixTimer);
      clearInterval(paceTimer);
      this.agent.stop(guildId);
      for (const { opus, decoder } of decoders.values()) {
        try {
          opus.destroy();
          decoder.destroy();
        } catch {}
      }
      decoders.clear();
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
