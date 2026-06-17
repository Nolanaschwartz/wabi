import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import {
  createLangfuseTracing,
  startObservation,
  type LangfuseTracing,
  type SpanContext,
} from '@wabi/shared/otel';
import { defaultLogger, Logger } from '../util/logger';

/**
 * ResearchTracer — first-class Langfuse tracing for the research worker (ADR-0038, ADR-0024).
 *
 * Re-expresses the run/paper tree over the official Langfuse OpenTelemetry SDK (`createLangfuseTracing`),
 * adding ONLY the research-worker policy: the run/paper span VOCABULARY. A RUN is the parent
 * observation; each paper's `gate`/`extract`/`dedup` LLM calls become child generations under it,
 * carrying the leaf data (`input`/`output`, `model`, `usage`, `latencyMs`) the migrated callers surface
 * from `generate`. The SDK owns the mechanism (sampling, batching, the flush deadline race).
 *
 * Deliberately UNLIKE the bot's `LangfuseTracer`: there is NO crisis latch and NO content redaction.
 * The research worker handles no end-user content and has no crisis concept — a "crisis-like" string in
 * an abstract is just text, and suppressing it would be meaningless. The bot's latch/redaction are
 * Wellbeing-context concerns (ADR-0013/0024) that stay in the bot.
 *
 * Every failure is swallowed and logged (ADR-0021) — tracing must NEVER break a run. Disabled (no
 * Langfuse env) is a clean no-op via the fail-open createLangfuseTracing handle.
 */

// The research span vocabulary — one enumerated union, never ad-hoc strings at call sites. These
// mirror the three LLM steps the orchestrator drives per paper.
export type ResearchSpanName = 'gate' | 'extract' | 'dedup';

export interface RunTraceInput {
  /** The orchestrator's run id — used to correlate this run's spans to one parent observation. */
  runId: string;
  /** Optional run-level metadata (topic, counts) — never verbatim user content (there is none). */
  metadata?: Record<string, unknown>;
}

export interface ResearchSpanInput {
  runId: string;
  span: ResearchSpanName;
  /** The prompt-side content the step saw (abstract / body / candidate pair). On-infra, retained. */
  input: string;
  /** The model's reply for the step. */
  output: string;
  /** Wall-clock latency of the underlying generate call, in ms. */
  latencyMs?: number;
  /** Resolved model id for the call (cost/identity signal). */
  model?: string;
  /** Token usage as generate reported it — fields present only when the provider returned them. */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Extra structured metadata (counts / ids) — never verbatim user content. */
  metadata?: Record<string, unknown>;
}

// Dev keeps full visibility (sample everything); prod samples 10%. Read per-call from env so it tracks
// the running environment, never frozen at import. LANGFUSE_SAMPLE_RATE overrides both.
function resolveSampleRate(): number {
  const override = process.env.LANGFUSE_SAMPLE_RATE;
  if (override !== undefined && override !== '') {
    const parsed = Number(override);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return process.env.NODE_ENV === 'production' ? 0.1 : 1.0;
}

// How long onApplicationShutdown waits for in-flight spans to flush before giving up. A Langfuse that
// accepts the connection but never responds must not block process exit indefinitely (ADR-0021).
function flushTimeoutMs(): number {
  const parsed = Number(process.env.LANGFUSE_FLUSH_TIMEOUT_MS);
  return Number.isNaN(parsed) || parsed <= 0 ? 5000 : parsed;
}

// An open run-root observation: kept LIVE so children nest under it (ending it before its children
// makes the SDK treat each child as its own app-root, fragmenting the tree). Stored with its span
// context for parenting, plus the handle to end it when the run completes.
interface OpenRun {
  end(): void;
  context: SpanContext;
}

@Injectable()
export class ResearchTracer implements OnApplicationShutdown {
  private readonly log: Logger;
  private readonly tracing: LangfuseTracing;
  // runId -> the run's LIVE root observation, so each paper's spans parent under one run trace.
  private readonly runRoots = new Map<string, OpenRun>();

  constructor(log: Logger = defaultLogger()) {
    this.log = log;
    this.tracing = createLangfuseTracing({ serviceName: 'wabi-research', sampleRate: resolveSampleRate() });
  }

  /**
   * Open the run's parent observation and keep it LIVE so every later {@link span} nests under it. The
   * root is ended by {@link endRun} when the run completes — NOT here — because ending it first would
   * make the SDK tag each child as its own app-root and fragment the run/paper tree. Never throws.
   */
  run(input: RunTraceInput): void {
    try {
      const root = startObservation('run', { metadata: input.metadata }, { asType: 'span' });
      this.runRoots.set(input.runId, { end: () => root.end(), context: root.otelSpan.spanContext() });
    } catch (err) {
      this.log.info(`research tracer run threw: ${err}`);
    }
  }

  /**
   * Emit one child generation (`gate`/`extract`/`dedup`) under the run's still-open parent, carrying the
   * leaf data the orchestrator passes through. Each wraps an LLM call, so every span is a generation
   * (model/usage render for costing). No-op-safe; never throws (ADR-0021).
   */
  span(input: ResearchSpanInput): void {
    try {
      const parentSpanContext = this.runRoots.get(input.runId)?.context;
      // Backdate the start so the span's duration reflects the measured generate latency.
      const startTime = input.latencyMs != null ? new Date(Date.now() - input.latencyMs) : undefined;

      const attributes: Record<string, unknown> = {
        // On-infra retention is permitted here (ADR-0017): the worker reads only public papers.
        input: input.input,
        output: input.output,
        metadata: { latencyMs: input.latencyMs ?? 0, ...(input.metadata ?? {}) },
      };
      if (input.model) attributes.model = input.model;
      if (input.usage) {
        attributes.usageDetails = { input: input.usage.inputTokens, output: input.usage.outputTokens };
      }

      const obs = startObservation(
        input.span,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        attributes as any,
        { asType: 'generation', startTime, parentSpanContext },
      );
      obs.end();
    } catch (err) {
      this.log.info(`research tracer span threw: ${err}`);
    }
  }

  /** Close the run's root observation once the run completes, so it exports and the tree is whole. */
  endRun(runId: string): void {
    try {
      this.runRoots.get(runId)?.end();
    } catch (err) {
      this.log.info(`research tracer endRun threw: ${err}`);
    } finally {
      this.runRoots.delete(runId);
    }
  }

  /**
   * Push in-flight spans to Langfuse WITHOUT tearing the provider down — called per run so a long-lived
   * (singleton) tracer flushes between runs. Deadline-bounded: a Langfuse that accepts the connection but
   * never responds must not block the worker. Never throws.
   */
  async flush(): Promise<void> {
    await Promise.race([
      this.tracing.forceFlush(),
      new Promise<void>((resolve) => setTimeout(resolve, flushTimeoutMs())),
    ]);
  }

  // Flush + tear down on process exit. Ends any still-open run roots first so their trees aren't lost.
  async onApplicationShutdown(): Promise<void> {
    for (const runId of [...this.runRoots.keys()]) this.endRun(runId);
    await this.tracing.shutdown(flushTimeoutMs());
  }
}
