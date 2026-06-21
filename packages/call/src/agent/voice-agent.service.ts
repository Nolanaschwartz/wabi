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

// STT/LLM/TTS calls hit self-hosted endpoints that can hang with no response. An unbounded await in
// respond() strands it — its .finally never runs, so the detector stays suppressed and the agent goes
// permanently deaf with no error. Bound each call so a hung endpoint fails soft (caught in respond)
// and the detector resumes. ponytail: generous caps, fail-open — widen only if a real call needs it.
const STT_TIMEOUT_MS = 15_000;
const LLM_TIMEOUT_MS = 30_000;
const TTS_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// Like withTimeout but per-step over a stream: each next() must arrive within `ms` (an IDLE timeout),
// so a stalled LLM stream can't strand respond() forever. The underlying error (HTTP/abort) also
// propagates — abort fires when a barge cancels the turn.
async function* withIdleTimeout<T>(
  it: AsyncIterable<T>,
  ms: number,
  label: string,
): AsyncGenerator<T> {
  const iter = it[Symbol.asyncIterator]();
  for (;;) {
    const r = await withTimeout(Promise.resolve(iter.next()), ms, label);
    if (r.done) return;
    yield r.value;
  }
}

// Pull COMPLETE sentences (runs ending in . ! ?) off the front of a streaming buffer, leaving the
// trailing partial in `rest` for the next delta. The turn loop synth's each completed sentence while
// the LLM keeps generating, so first audio lands after sentence 1. ponytail: naive punctuation split —
// "3.14"/"Dr." over-split into two chunks (a harmless extra TTS boundary); swap for an NLP segmenter
// only if that ever sounds wrong.
export function takeSentences(buf: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  const re = /[^.!?]*[.!?]+/g;
  let end = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buf)) !== null) {
    const s = m[0].trim();
    if (s) sentences.push(s);
    end = re.lastIndex;
  }
  return { sentences, rest: buf.slice(end) };
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
  abort?: AbortController; // in-flight reply's LLM stream; barge-in aborts it
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
        session.abort?.abort(); // stop the LLM stream even if it's mid-think (no delta to break on)
        session.sink.clear();
        continue;
      }

      session.detector.setSuppressed(true);
      this.respond(session, event.utterance).finally(() => {
        session.detector.setSuppressed(false);
      });
    }
  }

  private async respond(session: Session, utt: Utterance): Promise<void> {
    const ctrl = new AbortController();
    session.abort = ctrl; // so a barge-in can abort the LLM stream mid-think
    try {
      const wav = buildWav(utt.pcm, utt.rate, utt.channels);
      const text = (
        await withTimeout(this.pipeline!.transcriber.transcribe(wav), STT_TIMEOUT_MS, 'transcribe')
      ).trim();
      if (!text) return;
      this.log.log(`heard: ${text}`);
      session.messages.push({ role: 'user', content: text });

      // Clear any barge that fired during STT — the assistant isn't audible yet, so it had nothing to
      // interrupt. From here, only a barge DURING playback (below) stops the reply.
      session.cancel = false;

      // prefetch(): start a sentence's TTS and attach a no-op catch, so an in-flight-but-unplayed synth
      // (barge/hangup mid-reply) can't surface as an unhandledRejection.
      const prefetch = (chunk: string): Promise<Int16Array> => {
        const p = this.synth(chunk);
        p.catch(() => {});
        return p;
      };

      // Stream the reply token-by-token; as each full sentence forms, synth it and play sentences in
      // order with ONE synth running a sentence ahead of playback (overlap). The LLM keeps generating
      // while a sentence plays, so first audio lands after sentence 1 — not the whole reply.
      let full = '';
      let buf = '';
      let pending: Promise<Int16Array> | null = null;
      const playPending = async (): Promise<void> => {
        if (!pending) return;
        const p = pending;
        pending = null;
        const pcm = await p; // bounded by the TTS timeout in synth()
        if (session.cancel || session.closed) return;
        await session.sink.write(pcm, () => session.cancel || session.closed);
      };

      const stream = withIdleTimeout(
        this.pipeline!.responder.respondStream(session.messages, ctrl.signal),
        LLM_TIMEOUT_MS,
        'responder',
      );
      for await (const delta of stream) {
        if (session.cancel || session.closed) break;
        full += delta;
        buf += delta;
        const { sentences, rest } = takeSentences(buf);
        buf = rest;
        for (const s of sentences) {
          const next = prefetch(s); // start this sentence's synth (overlaps prior playback + streaming)
          await playPending(); // play the previously-prefetched sentence
          if (session.cancel || session.closed) break;
          pending = next;
        }
      }
      // Flush: the last prefetched sentence, then any trailing partial that never hit punctuation.
      await playPending();
      const tail = buf.trim();
      if (tail && !(session.cancel || session.closed)) {
        pending = prefetch(tail);
        await playPending();
      }

      full = full.trim();
      if (full) {
        session.messages.push({ role: 'assistant', content: full });
        if (session.messages.length > 11) {
          session.messages.splice(1, session.messages.length - 11); // keep system + last 10
        }
      }
      this.log.log(`reply: ${full}`);
    } catch (e) {
      if (session.cancel || session.closed) this.log.log('reply interrupted');
      else this.log.error(`pipeline failed: ${(e as Error).message}`);
    } finally {
      ctrl.abort(); // close the LLM stream if a barge/error left it open
      if (session.abort === ctrl) session.abort = undefined;
    }
  }

  // Synthesize one text chunk to OUT_RATE mono PCM.
  private async synth(text: string): Promise<Int16Array> {
    const out = parseWav(
      await withTimeout(this.pipeline!.synthesizer.synthesize(text), TTS_TIMEOUT_MS, 'synthesize'),
    );
    return resampleToMono(out.data, out.rate, out.channels, OUT_RATE);
  }
}
