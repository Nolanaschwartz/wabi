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
import { SpeakerMixer } from './speaker-mixer';
import { VoicePlayout, STARTUP_PRIME_BYTES } from './voice-playout';

// Discord voice is always 48kHz stereo s16le.
const RATE = 48000;
const CHANNELS = 2;
const FRAME_SAMPLES = 960; // 20ms @ 48kHz

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

    // --- agent -> Discord (set up first so the playout buffer exists before the agent starts) ---
    // VoicePlayout owns the pending-PCM buffer, the realtime pacer, and the slice-6 drain signal: the
    // agent dumps a whole reply into it faster than realtime via write(); pump() (driven by paceTimer
    // below) drains it at realtime into pcmOut, keeping a small cushion of real audio and a silence floor
    // so the player never latches to idle. outSink is a thin closed-aware delegate to it.
    const playout = new VoicePlayout(STARTUP_PRIME_BYTES); // prime the startup backlog for streaming synth
    const pcmOut = new Readable({ read() {} });
    this.outs.set(guildId, pcmOut);

    const outSink: ReplySink = {
      write: (pcm) => {
        if (closed) return;
        playout.write(pcm);
      },
      clear: () => playout.clear(),
      flush: () => playout.flush(), // reply done: release the prime so a short reply still plays out
      whenDrained: () => playout.whenDrained(),
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

    // Realtime playout pacer: each tick, VoicePlayout fills the cushion of real audio and the silence
    // floor into pcmOut and updates its drain signal. The two-tier buffering and drain semantics live in
    // the module (voice-playout.ts); the bridge only owns the clock and the Discord Readable.
    const paceTimer = setInterval(() => {
      if (closed) return;
      playout.pump(pcmOut);
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
      playout.close(); // pacer is about to stop; resolve any pending/future drain gate so the detector
      //                  isn't stranded suppressed (deaf) after teardown — fail-open
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
