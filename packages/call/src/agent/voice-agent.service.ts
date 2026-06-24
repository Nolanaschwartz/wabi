import { Injectable, Logger } from '@nestjs/common';
import { loadAgentConfig } from './agent.config';
import { buildWav, resampleToMono, fadeIn } from './audio.util';
import { TurnDetector, TurnDetectorOpts, Utterance } from './turn-detector';
import { ChatMessage, SpeechPipeline } from './speech';
import { createOpenAiPipeline } from './openai-speech';
import { composeSystemPrompt } from './memory-context';
import { TurnTimer } from './turn-timer';
import { splitFirstChunk } from './first-chunk';

// Where synthesized reply audio goes. The agent writes 24kHz mono PCM chunks; the implementation (the
// Discord bridge) resamples to its output format and paces playout. clear() drops queued audio on barge.
export interface ReplySink {
  write(pcm: Int16Array): void;
  clear(): void;
  // Resolves when assistant audio has finished PLAYING OUT — not just been received from TTS. TTS runs
  // faster than realtime, so respond() finishes receiving the reply while the bridge keeps playing the
  // tail out of its buffer for up to a few seconds; the detector must stay suppressed for that whole
  // tail (slice 6), or speech in the tail starts a new turn instead of barging. The bridge resolves
  // this when its outBuf is empty and the pacer has no real frames left, and also on clear()/teardown
  // so the gate is never left hanging. Optional: a sink without it (test fakes) means "no playout tail
  // to wait for" — the caller un-suppresses immediately.
  whenDrained?(): Promise<void>;
}

// Fail-open backstop for the drain gate. If the bridge's drain signal is missed (a frame-accounting
// bug, a swallowed teardown), the detector must NOT stay suppressed (deaf) forever. After this long we
// un-suppress regardless — a missed drain is worse than re-opening the mic a touch early. Generous:
// real playout tails are 1-3s, so this only fires on a genuinely stuck signal. Mirrors the withTimeout
// fail-soft philosophy below.
const DRAIN_TIMEOUT_MS = 8_000;

// STT/LLM/TTS calls hit self-hosted endpoints that can hang with no response. An unbounded await in
// respond() strands it — its .finally never runs, so the detector stays suppressed and the agent goes
// permanently deaf with no error. Bound each call so a hung endpoint fails soft (caught in respond)
// and the detector resumes. ponytail: generous caps, fail-open — widen only if a real call needs it.
const STT_TIMEOUT_MS = 15_000;
const LLM_TIMEOUT_MS = 30_000;
const TTS_TIMEOUT_MS = 15_000; // streaming: per-frame idle gap, not whole-clip (see STREAM_TTS)
// Per-endpoint cap on the start-of-session connection warm-up. Generous but bounded so a cold/down
// endpoint delays the call coming online by at most this, then we proceed (fail-open).
const WARMUP_TIMEOUT_MS = 4_000;
// ~5ms fade-in on the remainder clip's onset (24kHz synth rate) to mask the click at the chunk1->remainder
// seam. The click-suppression knob: lengthen if the seam still pops, shorten if it softens word onsets.
const FADE_SAMPLES = 120;

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
  // Sustained speech (while the assistant talks) before a barge fires. Dominates perceived interrupt
  // latency (~bargeMs detection + ~one cushion of queued audio). 180ms feels snappy; lower risks a cough
  // or "mm-hm" backchannel cutting the assistant off. Tuned after slice 6 made tail-interruption correct.
  bargeMs: 180,
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
  private warmed = false; // connection pools warmed once on first session start

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

    // Warm the STT/LLM/TTS connection pools once so the first real turn doesn't pay a fresh TLS/TCP
    // handshake (~1 RTT off tts_first et al.). Awaited so the TTS warm fully drains before any real
    // synth — the server is single-stream, and a half-open warm stream would corrupt the first reply.
    if (!this.warmed) {
      this.warmed = true;
      await this.warmUp();
    }

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

  // Best-effort, fail-open connection warm-up: hit each endpoint once so the pool is hot before the
  // first turn. Output is discarded (never reaches the sink). The TTS warm is fully drained because the
  // server is single-stream. Each ping is bounded + caught so a down endpoint can't block the call.
  private async warmUp(): Promise<void> {
    const p = this.pipeline;
    if (!p) return;
    const ping = (label: string, fn: () => Promise<void>) =>
      withTimeout(fn(), WARMUP_TIMEOUT_MS, label).catch(() => undefined);
    await Promise.all([
      ping('warm-stt', async () => {
        await p.transcriber.transcribe(buildWav(new Int16Array(160), 16000, 1));
      }),
      ping('warm-llm', async () => {
        for await (const _ of p.responder.respondStream([
          { role: 'user', content: 'hi' },
        ])) {
          /* drain */
        }
      }),
      ping('warm-tts', async () => {
        for await (const _ of p.synthesizer.synthesizeStream('hi')) {
          /* drain fully — single-stream server must not see a half-open warm stream */
        }
      }),
    ]);
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
      // respond() resolving means the reply has been RECEIVED from TTS, not that it has finished
      // PLAYING. Keep the detector suppressed through the playout tail (the bridge drains outBuf faster
      // than the reply was synthesized) so tail speech barges instead of starting a new turn. Gate
      // un-suppress on the bridge's drain signal, behind a fail-open timeout so a missed signal can
      // never leave the detector deaf. (clear() on barge and teardown resolve whenDrained() too.)
      void this.afterDrained(session).then(() => {
        session.detector.setSuppressed(false);
      });
    });
  }

  // Resolve when the bridge reports playout drained, or after DRAIN_TIMEOUT_MS as a fail-open backstop,
  // whichever comes first. A sink with no whenDrained() (test fakes) has no tail to wait for.
  private afterDrained(session: Session): Promise<void> {
    const drained = session.sink.whenDrained?.();
    if (!drained) return Promise.resolve();
    return withTimeout(drained, DRAIN_TIMEOUT_MS, 'drain').catch(() => undefined);
  }

  // Synthesize one text chunk to the sink. Marks 'audio' on the first frame of the reply (idempotent via
  // the local guard, so chunk1's first frame wins the onset mark). Returns the PCM sample count for the
  // synth_audio canary. Honors barge/teardown via cancel/closed.
  private async synthChunk(
    session: Session,
    text: string,
    signal: AbortSignal,
    timer: TurnTimer,
    fade = false, // fade the onset in — only the remainder clip, to mask the chunk1->remainder seam click
  ): Promise<number> {
    let first = true;
    let samples = 0;
    let faded = 0;
    const frames = withIdleTimeout(
      this.pipeline!.synthesizer.synthesizeStream(text, signal),
      TTS_TIMEOUT_MS,
      'synthesize',
    );
    for await (const pcm of frames) {
      if (session.cancel || session.closed) break;
      if (first) {
        first = false;
        timer.mark('audio');
      }
      if (fade && faded < FADE_SAMPLES) faded = fadeIn(pcm, faded, FADE_SAMPLES);
      samples += pcm.length;
      session.sink.write(pcm);
    }
    return samples;
  }

  private async respond(session: Session, utt: Utterance): Promise<void> {
    const ctrl = new AbortController();
    session.abort = ctrl; // so a barge-in can abort the LLM stream mid-think
    const timer = new TurnTimer(); // t0 = utterance ready; marks each stage, logs one `latency` line
    try {
      // Downsample the capture (48kHz stereo from Discord) to 16kHz mono before STT: ~6x fewer bytes to
      // upload/decode, and Whisper-class STT resamples to 16k mono internally anyway — no accuracy loss.
      const sttPcm = resampleToMono(utt.pcm, utt.rate, utt.channels, 16000);
      const wav = buildWav(sttPcm, 16000, 1);
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

      // Stream the reply token-by-token. As soon as the splitter yields a sizeable first chunk (a sentence
      // boundary past MIN_FIRST_CHARS), synthesize it WHILE the LLM keeps generating the rest — first audio
      // starts after chunk1 instead of the last token. Single-stream-safe: chunk1 synth overlaps only the
      // LLM token stream, and the remainder synth runs strictly AFTER chunk1 drains (never two at once).
      let full = '';
      let firstDelta = true;
      let chunk1: string | null = null;
      let synth1: Promise<number> | undefined;
      let synthSamples = 0; // diagnostic: total PCM samples synthesized for this reply
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
        if (!chunk1) {
          const split = splitFirstChunk(full);
          if (split) {
            chunk1 = split.chunk1;
            timer.mark('sentence'); // first synthesizable chunk ready — drives onset
            session.sink.clear(); // drop the prior reply's tail before this reply's first write
            synth1 = this.synthChunk(session, chunk1, ctrl.signal, timer);
          }
        }
      }
      // Settle the in-flight chunk1 synth before the remainder (single-stream: never two synths at once),
      // and so a barge-aborted synth can't dangle as an unhandled rejection.
      if (synth1) synthSamples += await synth1.catch(() => 0);

      const reply = full.trim();
      if (chunk1) {
        // Two-phase: chunk1 already synthesized above; now the remainder as one request.
        const rest = full.slice(chunk1.length).trim();
        if (rest && !(session.cancel || session.closed)) {
          synthSamples += await this.synthChunk(session, rest, ctrl.signal, timer, true); // fade the seam
        }
      } else if (reply && !(session.cancel || session.closed)) {
        // No split (short/run-on reply) — synthesize the whole reply as one request (the original path).
        timer.mark('sentence');
        session.sink.clear();
        synthSamples += await this.synthChunk(session, reply, ctrl.signal, timer);
      }
      if ((chunk1 || reply) && !(session.cancel || session.closed)) {
        // synth_audio ≫ the reply's natural spoken length = the server stretched it; canary for regressions.
        this.log.log(`synth_audio=${(synthSamples / 24000).toFixed(2)}s (24kHz mono)`);
      }

      if (reply) {
        session.messages.push({ role: 'assistant', content: reply });
        if (session.messages.length > 11) {
          session.messages.splice(1, session.messages.length - 11); // keep system + last 10
        }
      }
      this.log.log(`reply: ${reply}`);
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
