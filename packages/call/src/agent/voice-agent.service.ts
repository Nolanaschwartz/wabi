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
import { buildWav, fadeIn } from './audio.util';
import { TurnDetector, TurnDetectorOpts, Utterance } from './turn-detector';
import { AudioSink } from './audio-sink';
import { ChatMessage, SpeechPipeline } from './speech';
import { createOpenAiPipeline } from './openai-speech';
import { composeSystemPrompt } from './memory-context';
import { TurnTimer } from './turn-timer';
import { prefetchSynth, SynthFn } from './synth-prefetcher';

// Publish the assistant track at the TTS's native rate (24kHz mono) and let LiveKit resample to the
// Discord bridge's 48kHz/stereo with its native resampler (the bridge's AudioStream already requests a
// format and LiveKit converts). Avoids a hand-rolled linear-interp resample on the hot path.
const SYNTH_RATE = 24000; // TTS pcm response_format is 24kHz mono s16le (OpenAI /v1/audio/speech spec)
const FADE_SAMPLES = Math.round(SYNTH_RATE * 0.008); // ~8ms fade-in to de-click the reply onset

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

// Minimal single-producer/single-consumer async queue. push() never blocks; the async iterator yields
// items in push order and ends after close(). Lets the producer (LLM stream → synth) run ahead while
// the consumer (playback) drains in order — so a sentence plays the moment ITS synth resolves, not a
// sentence behind, while later synths overlap.
class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private done = false;
  push(item: T): void {
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }
  close(): void {
    this.done = true;
    let w: ((r: IteratorResult<T>) => void) | undefined;
    while ((w = this.waiters.shift())) w({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length)
          return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((res) => this.waiters.push(res));
      },
    };
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

// TTS first-frame dominates time-to-first-word: the server buffers the whole chunk before returning
// audio, so a long first sentence = a long wait. Flush a SMALLER first unit so the opener synthesizes
// fast; later chunks revert to whole sentences (prefetch hides their seams). Only the first chunk of a
// turn uses this — it's the one the user is waiting on. Returns null until a good early cut exists.
// ponytail: char thresholds, tune via the `latency` line's tts_first. Won't help a short, boundary-less
// reply (nothing to cut) — that needs server-side TTS streaming, which is off by choice.
const FIRST_MIN = 10; // don't fragment tiny openers at an early comma ("Hi,")
const FIRST_MAX = 48; // bound a run-on with no punctuation at all
export function takeFirstChunk(buf: string): { chunk: string | null; rest: string } {
  // Cut at the EARLIEST boundary so a long opener doesn't synthesize whole: a terminal .!? (always a
  // clean cut, even short — "Hi.") or a clause ,;:— past FIRST_MIN (so we don't split "Hi,"). Whichever
  // comes first wins — a comma at char 15 beats a period at char 45.
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c === '.' || c === '!' || c === '?') {
      let j = i;
      while (j + 1 < buf.length && /[.!?]/.test(buf[j + 1])) j++; // include a run ("...")
      const chunk = buf.slice(0, j + 1).trim();
      if (chunk) return { chunk, rest: buf.slice(j + 1) };
    }
    if ((c === ',' || c === ';' || c === ':' || c === '—') && i >= FIRST_MIN - 1) {
      return { chunk: buf.slice(0, i + 1).trim(), rest: buf.slice(i + 1) };
    }
  }
  // No boundary yet — cut a long run-on at the last word break under FIRST_MAX, else keep waiting.
  if (buf.length >= FIRST_MAX) {
    const cut = buf.lastIndexOf(' ', FIRST_MAX);
    const at = cut > FIRST_MIN ? cut : FIRST_MAX;
    return { chunk: buf.slice(0, at).trim(), rest: buf.slice(at) };
  }
  return { chunk: null, rest: buf };
}

// ponytail: energy-based turn detection — tune to your room; swap for Silero if it mis-triggers.
const TURN_OPTS: TurnDetectorOpts = {
  vadRms: 600,
  // Trailing silence before a turn dispatches. The `total` in respond()'s per-turn `latency` line is
  // the tuning signal: lower this to cut response delay, but don't go below ~250–300ms or speakers
  // who pause mid-thought get clipped.
  hangoverMs: 400,
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

    // queueSize 100ms (default 1000ms): the reply is fully synthesized before we write it, so a deep
    // playout buffer just adds latency between writing and hearing. A small buffer keeps it snappy; the
    // data is all ready so it won't underrun.
    const source = new AudioSource(SYNTH_RATE, 1, 100);
    const track = LocalAudioTrack.createAudioTrack('assistant', source);
    const opts = new TrackPublishOptions();
    opts.source = TrackSource.SOURCE_MICROPHONE;
    await room.localParticipant!.publishTrack(track, opts);

    const session: Session = {
      room,
      sink: new AudioSink(source, SYNTH_RATE, 1),
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
    const timer = new TurnTimer(); // t0 = utterance ready; marks each stage, logs one `latency` line
    try {
      const wav = buildWav(utt.pcm, utt.rate, utt.channels);
      const text = (
        await withTimeout(this.pipeline!.transcriber.transcribe(wav), STT_TIMEOUT_MS, 'transcribe')
      ).trim();
      timer.mark('stt');
      if (!text) return;
      this.log.log(`heard: ${text}`);
      session.messages.push({ role: 'user', content: text });

      // Clear any barge that fired during STT — the assistant isn't audible yet, so it had nothing to
      // interrupt. From here, only a barge DURING playback (below) stops the reply.
      session.cancel = false;

      // Producer: stream the reply token-by-token; as each full sentence forms, queue its TEXT.
      // Consumer: prefetchSynth synthesizes each sentence's TTS audio and plays its PCM frames straight
      // to the sink — first audio ~0.6s after the sentence forms, not after its whole synth. It runs
      // depth-1 ahead: sentence N+1 synthesizes while N is still playing, so the ~0.6s TTS first-frame no
      // longer shows up as a gap at each sentence boundary.
      const queue = new AsyncQueue<string>();
      let full = '';
      let produceErr: unknown;
      let firstSentence = true;
      let firstChunkChars = 0; // size of the opener — confirms early-flush is producing a small unit
      const pushSentence = (s: string): void => {
        if (firstSentence) {
          firstChunkChars = s.length;
          timer.mark('sentence');
          firstSentence = false;
        }
        queue.push(s);
      };
      const produce = (async () => {
        let buf = '';
        let firstDelta = true;
        let firstChunkDone = false;
        try {
          const stream = withIdleTimeout(
            this.pipeline!.responder.respondStream(session.messages, ctrl.signal),
            LLM_TIMEOUT_MS,
            'responder',
          );
          for await (const delta of stream) {
            if (session.cancel || session.closed) break;
            if (firstDelta) {
              timer.mark('llm');
              firstDelta = false;
            }
            full += delta;
            buf += delta;
            // Flush a small first unit early (the user is waiting on it); then whole sentences.
            if (!firstChunkDone) {
              const { chunk, rest } = takeFirstChunk(buf);
              if (!chunk) continue; // no good early cut yet — keep accumulating
              buf = rest;
              firstChunkDone = true;
              pushSentence(chunk);
            }
            const { sentences, rest } = takeSentences(buf);
            buf = rest;
            for (const s of sentences) pushSentence(s);
          }
          const tail = buf.trim();
          if (tail && !(session.cancel || session.closed)) pushSentence(tail);
        } catch (e) {
          produceErr = e;
        } finally {
          queue.close();
        }
      })();

      // idle-timeout guards a stalled TTS per next(); the sink carries sub-frame remainders across writes
      // (and across sentences), so playback stays frame-aligned and gap-free.
      const synth: SynthFn = (text, sig) =>
        withIdleTimeout(
          this.pipeline!.synthesizer.synthesizeStream(text, sig),
          TTS_TIMEOUT_MS,
          'synthesize',
        );
      let firstChunk = true;
      for await (const frames of prefetchSynth(
        queue,
        synth,
        ctrl.signal,
        () => session.cancel || session.closed,
      )) {
        if (session.cancel || session.closed) break;
        for await (const pcm of frames) {
          if (session.cancel || session.closed) break;
          if (firstChunk) {
            fadeIn(pcm, FADE_SAMPLES); // de-click the reply onset (TTS stream starts mid-waveform)
            firstChunk = false;
            timer.mark('audio');
            this.log.log('first audio');
          }
          // 24kHz mono straight to the sink; LiveKit resamples to the bridge's 48kHz/stereo.
          await session.sink.write(pcm, () => session.cancel || session.closed);
        }
      }
      if (!(session.cancel || session.closed)) {
        await session.sink.flush(() => session.cancel || session.closed); // emit the final sub-frame tail
      }
      await produce; // settle the producer (history/`full` are complete once it returns)
      if (produceErr) throw produceErr;

      full = full.trim();
      if (full) {
        session.messages.push({ role: 'assistant', content: full });
        if (session.messages.length > 11) {
          session.messages.splice(1, session.messages.length - 11); // keep system + last 10
        }
      }
      this.log.log(`reply: ${full}`);
      if (!(session.cancel || session.closed)) {
        timer.mark('done');
        // one structured per-turn latency line on the clean path; chunk1 = opener size (small = good)
        this.log.log(`${timer.render()} chunk1=${firstChunkChars}c`);
      }
    } catch (e) {
      if (session.cancel || session.closed) this.log.log('reply interrupted');
      else this.log.error(`pipeline failed: ${(e as Error).message}`);
    } finally {
      ctrl.abort(); // close the LLM stream if a barge/error left it open
      if (session.abort === ctrl) session.abort = undefined;
    }
  }
}
