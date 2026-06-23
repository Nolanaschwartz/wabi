import { Injectable, Logger } from '@nestjs/common';
import { loadAgentConfig } from './agent.config';
import { buildWav } from './audio.util';
import { TurnDetector, TurnDetectorOpts, Utterance } from './turn-detector';
import { ChatMessage, SpeechPipeline } from './speech';
import { createOpenAiPipeline } from './openai-speech';
import { composeSystemPrompt } from './memory-context';
import { TurnTimer } from './turn-timer';

// Where synthesized reply audio goes. The agent writes 24kHz mono PCM chunks; the implementation (the
// Discord bridge) resamples to its output format and paces playout. clear() drops queued audio on barge.
export interface ReplySink {
  write(pcm: Int16Array): void;
  clear(): void;
}

// STT/LLM/TTS calls hit self-hosted endpoints that can hang with no response. An unbounded await in
// respond() strands it — its .finally never runs, so the detector stays suppressed and the agent goes
// permanently deaf with no error. Bound each call so a hung endpoint fails soft (caught in respond)
// and the detector resumes. ponytail: generous caps, fail-open — widen only if a real call needs it.
const STT_TIMEOUT_MS = 15_000;
const LLM_TIMEOUT_MS = 30_000;
// Buffered whole-reply synth (see STREAM_TTS): this bounds the ENTIRE clip's render, not a per-frame
// gap. A long reply can take 40s+ as one shot, so this is generous — at the cost of a hung TTS endpoint
// stranding the turn this long before it fails soft.
const TTS_TIMEOUT_MS = 60_000;

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

// ponytail: energy-based turn detection — tune to your room; swap for Silero if it mis-triggers.
const TURN_OPTS: TurnDetectorOpts = {
  vadRms: 600,
  // Trailing silence before a turn dispatches — pure additive onset latency on every turn (it fires
  // before the latency timer's t0, so it's invisible in the `latency` line). 300ms is the floor: lower
  // clips speakers who pause mid-thought. Raise back toward 400 if mid-sentence pauses get cut off.
  hangoverMs: 300,
  minTurnMs: 400,
  bargeMs: 250,
  prerollMs: 300,
};

interface Session {
  sink: ReplySink;
  detector: TurnDetector;
  messages: ChatMessage[];
  cancel: boolean; // set on barge-in; respond()'s stream/synth loops break on it
  closed: boolean;
  abort?: AbortController; // in-flight reply's LLM stream; barge-in aborts it
}

@Injectable()
export class VoiceAgentService {
  private readonly log = new Logger(VoiceAgentService.name);
  private readonly sessions = new Map<string, Session>(); // guildId -> session
  private pipeline?: SpeechPipeline;

  // Seam for tests: inject a fake pipeline before start().
  setPipeline(p: SpeechPipeline): void {
    this.pipeline = p;
  }

  // sink: where synthesized reply audio goes (the Discord bridge's output sink). memoryBlock: recalled
  // facts to prepend to the system prompt; '' = plain assistant (see issue 03).
  async start(id: string, sink: ReplySink, memoryBlock = ''): Promise<void> {
    if (this.sessions.has(id)) return;
    const cfg = loadAgentConfig(); // lazy — only needs AI env when a call starts
    this.pipeline ??= createOpenAiPipeline(cfg);

    this.sessions.set(id, {
      sink,
      detector: new TurnDetector(TURN_OPTS),
      messages: [
        { role: 'system', content: composeSystemPrompt(cfg.systemPrompt, memoryBlock) },
      ],
      cancel: false,
      closed: false,
    });
    this.log.log(`agent ready ${id}`);
  }

  stop(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.closed = true;
    s.abort?.abort();
    this.sessions.delete(id);
    this.log.log(`agent left ${id}`);
  }

  // Drive one input frame through the turn detector; dispatch utterances, honour barge-ins. The bridge
  // calls this per 20ms mixed Discord frame (48kHz stereo).
  feed(id: string, pcm: Int16Array, rate: number, channels: number): void {
    const session = this.sessions.get(id);
    if (!session || session.closed) return;
    const event = session.detector.push(pcm, rate, channels);
    if (!event) return;

    if ('barge' in event) {
      this.log.log('barge-in — cutting off assistant');
      session.cancel = true;
      session.abort?.abort(); // stop the LLM stream even if it's mid-think (no delta to break on)
      session.sink.clear();
      return;
    }

    session.detector.setSuppressed(true);
    this.respond(session, event.utterance).finally(() => {
      session.detector.setSuppressed(false);
    });
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

      // Stream the reply token-by-token, accumulating the full text, then chunk + synthesize below.
      // Waiting for the LLM's last token before synth is fine here: sent1 (last-token time) measures in
      // tens of ms — the latency is almost all TTFT, and the model emits the rest of the reply instantly.
      let full = '';
      let firstDelta = true;
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
      }
      full = full.trim();
      timer.mark('sentence'); // reply text ready for synth (sent1 = full-reply generation time)

      if (full && !(session.cancel || session.closed)) {
        // Drop any leftover from the previous reply before queueing this one. The TTS runs faster than
        // realtime, so each reply leaves an un-drained tail in the bridge's outBuf; without this, replies
        // append to that tail and playout falls further behind every turn (the voice drags over a session).
        // Safe: by now STT+LLM (~seconds) have elapsed, so the prior reply has finished playing out.
        session.sink.clear();
        let firstChunk = true;
        let synthSamples = 0; // diagnostic: total PCM samples synthesized for this reply
        // Synthesize the WHOLE reply in one buffered request: one request end-to-end, no sentence seams,
        // and the single-stream TTS server never sees overlapping requests (concurrent streams corrupt
        // each other — that was the prefetcher garble). Buffered because streaming stretches audio here.
        const frames = withIdleTimeout(
          this.pipeline!.synthesizer.synthesizeStream(full, ctrl.signal),
          TTS_TIMEOUT_MS,
          'synthesize',
        );
        for await (const pcm of frames) {
          if (session.cancel || session.closed) break;
          if (firstChunk) {
            firstChunk = false;
            timer.mark('audio');
          }
          synthSamples += pcm.length;
          session.sink.write(pcm);
        }
        // synth_audio ≫ the reply's natural spoken length = the server stretched it (a server-side bug,
        // worst on short/first inputs). Keep this line to spot regressions; rtf in the server logs confirms.
        this.log.log(`synth_audio=${(synthSamples / 24000).toFixed(2)}s (24kHz mono)`);
      }

      if (full) {
        session.messages.push({ role: 'assistant', content: full });
        if (session.messages.length > 11) {
          session.messages.splice(1, session.messages.length - 11); // keep system + last 10
        }
      }
      this.log.log(`reply: ${full}`);
      if (!(session.cancel || session.closed)) {
        timer.mark('done');
        this.log.log(timer.render()); // one structured per-turn latency line on the clean path
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
