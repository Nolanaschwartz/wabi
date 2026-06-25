import { Injectable, Logger } from '@nestjs/common';
import { loadAgentConfig } from './agent.config';
import { buildWav, resampleToMono } from './audio.util';
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
// Session PCM idle timeout. The FIRST frame can't arrive until the LLM emits its first text (TTFT, up to
// LLM_TIMEOUT on a slow reasoning turn), so this must clear that — not a tight per-frame gap.
const SESSION_TTS_TIMEOUT_MS = 35_000;
// Per-endpoint cap on the start-of-session connection warm-up. Generous but bounded so a cold/down
// endpoint delays the call coming online by at most this, then we proceed (fail-open).
const WARMUP_TIMEOUT_MS = 4_000;
// The TTS server serves one stream at a time; a barge's prior stream can still be tearing down when the
// next turn connects -> "server busy". Retry the open a few times to ride out that transient overlap.
const SESSION_BUSY_RETRIES = 3;
const SESSION_BUSY_BACKOFF_MS = 400;

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
  try {
    for (;;) {
      const r = await withTimeout(Promise.resolve(iter.next()), ms, label);
      if (r.done) return;
      yield r.value;
    }
  } finally {
    // Forward an early break/throw to the underlying iterator so it cleans up (streamSession closes its
    // socket; respondStream cancels its reader). Fire-and-forget: a generator parked on a never-settling
    // await must not hang this teardown — the turn's ctrl.abort() closes the resource regardless.
    void iter.return?.();
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
        const once = (async function* () {
          yield 'hi';
        })();
        for await (const _ of p.synthesizer.synthesizeSession(once)) {
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

  // Turn: feed LLM reply deltas into one continuous TTS session and pipe its PCM to the sink.
  // The session ends (server EOS flush) when the LLM stream completes; a barge aborts ctrl which closes
  // the session socket. One synthesis take, so no seam.
  private async respondViaSession(
    session: Session,
    ctrl: AbortController,
    timer: TurnTimer,
  ): Promise<void> {
    const pipeline = this.pipeline!;
    let full = '';
    let synthSamples = 0;

    // One attempt: stream the LLM reply through a fresh TTS session. full/synthSamples reset per attempt.
    const attempt = async (): Promise<void> => {
      full = '';
      synthSamples = 0;
      let firstDelta = true;
      let firstFrame = true;
      // Text source: the LLM deltas. Accumulates the full reply (for history) and marks llm/sentence. The
      // session pulls this as it generates; `sentence` marks when the last token is in (text complete).
      const textSource = async function* (): AsyncIterable<string> {
        const stream = withIdleTimeout(
          pipeline.responder.respondStream(session.messages, ctrl.signal),
          LLM_TIMEOUT_MS,
          'responder',
        );
        for await (const delta of stream) {
          if (session.cancel || session.closed) return;
          if (firstDelta) {
            timer.mark('llm');
            firstDelta = false;
          }
          full += delta;
          yield delta;
        }
        timer.mark('sentence'); // reply text complete (the session will get its `end`)
      };

      session.sink.clear();
      const frames = withIdleTimeout(
        pipeline.synthesizer.synthesizeSession(textSource(), ctrl.signal),
        SESSION_TTS_TIMEOUT_MS, // spans LLM TTFT (no PCM until the LLM emits text)
        'synthesize',
      );
      for await (const pcm of frames) {
        if (session.cancel || session.closed) break;
        if (firstFrame) {
          firstFrame = false;
          timer.mark('audio');
        }
        synthSamples += pcm.length;
        session.sink.write(pcm);
      }
    };

    // Ride out a transiently-busy single-stream server (see SESSION_BUSY_RETRIES). Re-runs the LLM on
    // retry — cheap at ~140 tk/s and rare. Don't retry once a barge/teardown has cancelled the turn.
    for (let i = 0; ; i++) {
      try {
        await attempt();
        break;
      } catch (e) {
        const busy = /server busy/i.test((e as Error)?.message ?? '');
        if (busy && i < SESSION_BUSY_RETRIES && !(session.cancel || session.closed)) {
          this.log.warn(`tts session busy — retry ${i + 1}/${SESSION_BUSY_RETRIES}`);
          await new Promise((r) => setTimeout(r, SESSION_BUSY_BACKOFF_MS));
          continue;
        }
        throw e;
      }
    }

    const reply = full.trim();
    if (reply) {
      session.messages.push({ role: 'assistant', content: reply });
      if (session.messages.length > 11) {
        session.messages.splice(1, session.messages.length - 11); // keep system + last 10
      }
    }
    if (reply && !(session.cancel || session.closed)) {
      this.log.log(`synth_audio=${(synthSamples / 24000).toFixed(2)}s (24kHz mono)`);
    }
    this.log.log(`reply: ${reply}`);
    if (!(session.cancel || session.closed)) {
      timer.mark('done');
      this.log.log(timer.render());
    }
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
      // interrupt. From here, only a barge DURING playback stops the reply.
      session.cancel = false;

      // Stream the reply text straight into ONE continuous TTS session (no per-request seam): the only
      // synth path. respondViaSession owns delta accumulation, single-stream busy-retry, and the latency
      // marks; the finally below still runs (aborts the ctrl, clears session.abort).
      await this.respondViaSession(session, ctrl, timer);
    } catch (e) {
      if (session.cancel || session.closed) this.log.log('reply interrupted');
      else this.log.error(`pipeline failed: ${(e as Error).message}`);
    } finally {
      ctrl.abort(); // close the LLM stream if a barge/error left it open
      if (session.abort === ctrl) session.abort = undefined;
    }
  }
}
