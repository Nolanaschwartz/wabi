import { Injectable, Logger } from '@nestjs/common';
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
import { loadAgentConfig } from './agent.config';
import { buildWav, parseWav, resampleToMono } from './audio.util';
import { TurnDetector, TurnDetectorOpts, Utterance } from './turn-detector';
import { AudioSink } from './audio-sink';
import { ChatMessage, SpeechPipeline } from './speech';
import { createOpenAiPipeline } from './openai-speech';
import { composeSystemPrompt } from './memory-context';

const OUT_RATE = 48000; // assistant publishes 48kHz mono

// Split a reply into sentence-ish chunks so TTS can start playing the first sentence while the rest
// is still being synthesized. ponytail: naive punctuation split — "3.14"/"Dr." over-split into two
// chunks, a harmless extra TTS boundary; swap for an NLP segmenter only if that ever sounds wrong.
export function splitForTts(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) ?? [text])
    .map((s) => s.trim())
    .filter(Boolean);
}

// ponytail: energy-based turn detection — tune to your room; swap for Silero if it mis-triggers.
const TURN_OPTS: TurnDetectorOpts = {
  vadRms: 600,
  hangoverMs: 800,
  minTurnMs: 400,
  bargeMs: 250,
  prerollMs: 300,
};

interface Session {
  room: Room;
  sink: AudioSink;
  detector: TurnDetector;
  messages: ChatMessage[];
  cancel: boolean; // set on barge-in; AudioSink.write stops on it
  closed: boolean;
}

@Injectable()
export class VoiceAgentService {
  private readonly log = new Logger(VoiceAgentService.name);
  private readonly sessions = new Map<string, Session>(); // roomName -> session
  private pipeline?: SpeechPipeline;

  constructor(private readonly livekit: LivekitService) {}

  // Seam for tests: inject a fake pipeline before start().
  setPipeline(p: SpeechPipeline): void {
    this.pipeline = p;
  }

  // memoryBlock: recalled facts to prepend to the system prompt; '' = plain assistant (see issue 03).
  async start(roomName: string, memoryBlock = ''): Promise<void> {
    if (this.sessions.has(roomName)) return;
    const cfg = loadAgentConfig(); // lazy — only needs AI env when a call starts
    this.pipeline ??= createOpenAiPipeline(cfg);

    const token = await this.livekit.createToken('assistant', roomName);
    const room = new Room();
    await room.connect(process.env.LIVEKIT_URL!, token, {
      autoSubscribe: true,
      dynacast: true,
    });

    const source = new AudioSource(OUT_RATE, 1);
    const track = LocalAudioTrack.createAudioTrack('assistant', source);
    const opts = new TrackPublishOptions();
    opts.source = TrackSource.SOURCE_MICROPHONE;
    await room.localParticipant!.publishTrack(track, opts);

    const session: Session = {
      room,
      sink: new AudioSink(source, OUT_RATE, 1),
      detector: new TurnDetector(TURN_OPTS),
      messages: [
        { role: 'system', content: composeSystemPrompt(cfg.systemPrompt, memoryBlock) },
      ],
      cancel: false,
      closed: false,
    };
    this.sessions.set(roomName, session);

    room.on(RoomEvent.TrackSubscribed, (t) => {
      if (t.kind === TrackKind.KIND_AUDIO)
        void this.listen(session, t as RemoteAudioTrack);
    });
    this.log.log(`agent joined ${roomName}`);
  }

  stop(roomName: string): void {
    const s = this.sessions.get(roomName);
    if (!s) return;
    s.closed = true;
    void s.room.disconnect();
    this.sessions.delete(roomName);
    this.log.log(`agent left ${roomName}`);
  }

  // Drive frames through the turn detector; dispatch utterances, honour barge-ins.
  private async listen(
    session: Session,
    track: RemoteAudioTrack,
  ): Promise<void> {
    const stream = new AudioStream(track);
    for await (const frame of stream) {
      if (session.closed) break;
      const event = session.detector.push(
        frame.data as Int16Array,
        frame.sampleRate,
        frame.channels,
      );
      if (!event) continue;

      if ('barge' in event) {
        this.log.log('barge-in — cutting off assistant');
        session.cancel = true;
        session.sink.clear();
        continue;
      }

      session.cancel = false;
      session.detector.setSuppressed(true);
      this.respond(session, event.utterance).finally(() => {
        session.detector.setSuppressed(false);
      });
    }
  }

  private async respond(session: Session, utt: Utterance): Promise<void> {
    try {
      const wav = buildWav(utt.pcm, utt.rate, utt.channels);
      const text = (await this.pipeline!.transcriber.transcribe(wav)).trim();
      if (!text) return;
      this.log.log(`heard: ${text}`);

      session.messages.push({ role: 'user', content: text });
      const reply = await this.pipeline!.responder.respond(session.messages);
      session.messages.push({ role: 'assistant', content: reply });
      if (session.messages.length > 11) {
        session.messages.splice(1, session.messages.length - 11); // keep system + last 10
      }
      this.log.log(`reply: ${reply}`);

      // Stream the reply sentence-by-sentence: play each chunk while the NEXT one is already being
      // synthesized (playback paces ~realtime, so the synth overlaps for free). First audio now lands
      // after the first sentence's TTS instead of the whole reply's.
      // prefetch(): kick off a chunk's synth and immediately attach a no-op catch, so an
      // in-flight-but-never-awaited prefetch can't escalate to an unhandledRejection no matter how the
      // loop exits (clean finish, barge-in/hangup break, or a rejecting sink.write throwing us into the
      // catch below). The explicit `await pending` still surfaces real synth errors into that catch.
      const prefetch = (text: string): Promise<Int16Array> => {
        const p = this.synth(text);
        p.catch(() => {});
        return p;
      };
      const chunks = splitForTts(reply);
      let pending: Promise<Int16Array> | null =
        chunks.length > 0 ? prefetch(chunks[0]) : null;
      for (let i = 0; i < chunks.length; i++) {
        const pcm = await pending!;
        pending = i + 1 < chunks.length ? prefetch(chunks[i + 1]) : null;
        if (session.cancel || session.closed) break;
        await session.sink.write(pcm, () => session.cancel || session.closed);
      }
    } catch (e) {
      this.log.error(`pipeline failed: ${(e as Error).message}`);
    }
  }

  // Synthesize one text chunk to OUT_RATE mono PCM.
  private async synth(text: string): Promise<Int16Array> {
    const out = parseWav(await this.pipeline!.synthesizer.synthesize(text));
    return resampleToMono(out.data, out.rate, out.channels, OUT_RATE);
  }
}
