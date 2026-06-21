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
import {
  Room,
  RoomEvent,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  TrackPublishOptions,
  TrackSource,
  TrackKind,
  RemoteAudioTrack,
} from '@livekit/rtc-node';
import { LivekitService } from '../livekit/livekit.service';
import { AudioSink } from '../agent/audio-sink';
import { SpeakerMixer } from './speaker-mixer';

// Discord voice is always 48kHz stereo s16le; we run LiveKit at the same rate so no resampling.
const RATE = 48000;
const CHANNELS = 2;
const FRAME_SAMPLES = 960; // 20ms @ 48kHz

@Injectable()
export class DiscordBridge {
  private readonly log = new Logger(DiscordBridge.name);
  private readonly sessions = new Map<string, () => void>(); // guildId -> cleanup
  private readonly outs = new Map<string, Readable>(); // guildId -> Discord PCM sink

  constructor(private readonly livekit: LivekitService) {}

  // Diagnostic: push 1s of 440Hz tone straight into the Discord player, bypassing LiveKit/TTS.
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

  async start(channel: VoiceBasedChannel): Promise<string> {
    const guildId = channel.guild.id;
    this.stop(guildId); // ponytail: one bridge per guild; restart replaces it

    const roomName = `discord-${guildId}`;

    // --- LiveKit: connect and publish the Discord audio as a mic track ---
    const token = await this.livekit.createToken('discord-bridge', roomName);
    const room = new Room();
    await room.connect(process.env.LIVEKIT_URL!, token, {
      autoSubscribe: true,
      dynacast: true,
    });

    const source = new AudioSource(RATE, CHANNELS);
    const track = LocalAudioTrack.createAudioTrack('discord', source);
    const pubOpts = new TrackPublishOptions();
    pubOpts.source = TrackSource.SOURCE_MICROPHONE;
    await room.localParticipant!.publishTrack(track, pubOpts);
    const sink = new AudioSink(source, RATE, CHANNELS);

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

    let closed = false; // set on hangup; stops captures into a torn-down LiveKit source

    // Discord -> LiveKit: decode each speaker separately and feed the mixer, which
    // combines simultaneous talkers into one steady 48kHz stereo stream.
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

    // Mixer tick: every 20ms pull one mixed frame and write it to LiveKit via the sink.
    // ponytail: setInterval clock; jitter is absorbed by the AudioSource queue.
    const mixTimer = setInterval(() => {
      if (closed) return;
      const mixed = mixer.tick();
      if (mixed) void sink.write(mixed); // sink owns offset-0 framing + close-race
    }, 20);

    // LiveKit -> Discord, PULL-paced. Discord pulls 20ms frames at playback rate; we hand back the next
    // buffered real frame, or silence when there's none. Pull-based (vs pushing on a timer) bounds the
    // stream to the consumer's high-water mark, so silence can't pile up ahead of real audio and delay it
    // — while still never starving (which would latch the player to idle and drop all audio).
    const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2; // 20ms @ 48kHz stereo s16le
    const SILENCE = Buffer.alloc(FRAME_BYTES);
    const MAX_OUT = FRAME_BYTES * 25; // ~500ms safety cap on the real-audio backlog (drop oldest beyond)
    let outBuf = Buffer.alloc(0); // remote PCM awaiting playout
    const pcmOut = new Readable({
      read() {
        if (outBuf.length >= FRAME_BYTES) {
          this.push(outBuf.subarray(0, FRAME_BYTES));
          outBuf = outBuf.subarray(FRAME_BYTES);
        } else {
          this.push(SILENCE);
        }
      },
    });
    this.outs.set(guildId, pcmOut);
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

    room.on(RoomEvent.TrackSubscribed, (t, _pub, participant) => {
      if (t.kind !== TrackKind.KIND_AUDIO) return;
      this.log.log(
        `forwarding LiveKit audio from "${participant?.identity}" -> Discord`,
      );
      const stream = new AudioStream(t as RemoteAudioTrack, RATE, CHANNELS);
      // ponytail: each remote track streamed unmixed — fine for 1:1, garbles if >1 speaks at once.
      // Upgrade path: sum Int16 frames into a mix buffer keyed by timestamp before push.
      void (async () => {
        for await (const frame of stream) {
          if (closed) break;
          // copy: rtc-node may reuse the frame buffer after we yield.
          const next = Buffer.copyBytesFrom(frame.data);
          outBuf = outBuf.length ? Buffer.concat([outBuf, next]) : next;
          if (outBuf.length > MAX_OUT) outBuf = outBuf.subarray(outBuf.length - MAX_OUT);
        }
      })().catch((e) => this.log.warn(`livekit stream: ${e.message}`));
    });

    this.log.log(`bridge up: #${channel.name} <-> LiveKit ${roomName}`);
    this.sessions.set(guildId, () => {
      closed = true; // stop captures/forwarding before tearing down the source
      clearInterval(mixTimer);
      try {
        connection.destroy();
      } catch {}
      pcmOut.push(null);
      this.outs.delete(guildId);
      void room.disconnect();
    });
    return roomName;
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
