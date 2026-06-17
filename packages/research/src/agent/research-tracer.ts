import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { LangfuseIngest } from '@wabi/shared/langfuse';
import { defaultLogger, Logger } from '../util/logger';

/**
 * ResearchTracer — first-class Langfuse tracing for the research worker (ADR-0037, ADR-0024).
 *
 * Wraps the content-AGNOSTIC `@wabi/shared/langfuse` kernel (`LangfuseIngest`) and adds ONLY the
 * research-worker policy on top: the run/paper span VOCABULARY. A RUN is the parent trace; each
 * paper's `gate`/`extract`/`dedup` LLM calls become child spans under it, carrying the leaf data
 * (`input`/`output`, `model`, `usage`, `latencyMs`) the migrated callers already surface from
 * `generate`. The kernel owns the mechanism (enablement, per-id sampling, the in-flight POST set,
 * the flush deadline race); the tracer owns nothing about the network.
 *
 * Deliberately UNLIKE the bot's `LangfuseTracer`: there is NO crisis latch and NO content redaction.
 * The research worker handles no end-user content and has no crisis concept — a "crisis-like" string
 * in an abstract is just text, and suppressing it would be meaningless. The bot's latch/redaction are
 * Wellbeing-context concerns (ADR-0013/0024) that stay in the bot.
 *
 * Every failure is swallowed and logged (ADR-0021) — tracing must NEVER break a run. Disabled (no
 * Langfuse env) is a clean no-op: no fetch, no per-call work.
 */

// The research span vocabulary — one enumerated union, never ad-hoc strings at call sites. These
// mirror the three LLM steps the orchestrator drives per paper.
export type ResearchSpanName = 'gate' | 'extract' | 'dedup';

export interface RunTraceInput {
  /** The trace id for the whole run — every span of the run hangs under this parent. */
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
function sampleRate(): number {
  const override = process.env.LANGFUSE_SAMPLE_RATE;
  if (override !== undefined && override !== '') {
    const parsed = Number(override);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return process.env.NODE_ENV === 'production' ? 0.1 : 1.0;
}

// How long onApplicationShutdown waits for in-flight ingestion before giving up. A Langfuse that
// accepts the connection but never responds must not block process exit indefinitely (ADR-0021).
function flushTimeoutMs(): number {
  const parsed = Number(process.env.LANGFUSE_FLUSH_TIMEOUT_MS);
  return Number.isNaN(parsed) || parsed <= 0 ? 5000 : parsed;
}

// Langfuse usage shape. Include only the token fields the provider actually returned — an omitted
// count must read as absent, never as 0. No fields → no usage block at all.
function compactUsage(usage?: { inputTokens?: number; outputTokens?: number }): { input?: number; output?: number } | undefined {
  if (!usage) return undefined;
  const out: { input?: number; output?: number } = {};
  if (typeof usage.inputTokens === 'number') out.input = usage.inputTokens;
  if (typeof usage.outputTokens === 'number') out.output = usage.outputTokens;
  return Object.keys(out).length ? out : undefined;
}

@Injectable()
export class ResearchTracer implements OnApplicationShutdown {
  private readonly log: Logger;
  // The shared, content-AGNOSTIC transport kernel (ADR-0037). It owns enablement, per-id sampling,
  // the in-flight POST set + cap, and the flush deadline race. The tracer adds only the span vocabulary.
  private readonly ingest: LangfuseIngest;

  // Optional logger seam (matches the rest of the research package, which threads a Logger). Defaults
  // to the env-gated stderr logger so a disabled-tracing process is still able to surface a warning.
  constructor(log: Logger = defaultLogger()) {
    this.log = log;
    this.ingest = new LangfuseIngest({ warn: (m) => this.log.info(m) });
  }

  // Evaluated per-call by the kernel, NOT cached: the tracer can be constructed before the process's
  // config populates process.env, which would freeze `enabled` to false and silently disable tracing
  // forever (the same load-order trap as @wabi/shared getProvider).
  private get enabled(): boolean {
    return this.ingest.enabled;
  }

  /**
   * Upsert the run's content-free parent trace. Optional — every {@link span} upserts it too — but
   * lets a run with zero papers still appear in Langfuse. Sampled and disabled-gated like a span.
   * Never throws (ADR-0021).
   */
  run(input: RunTraceInput): void {
    try {
      if (!this.enabled) return;
      if (!this.ingest.shouldSample(input.runId, sampleRate())) return;
      this.ingest.post('research-run', { batch: [this.traceEvent(input.runId, input.metadata)] });
    } catch (err) {
      this.log.info(`research tracer run threw: ${err}`);
    }
  }

  /**
   * Emit one child span (`gate`/`extract`/`dedup`) under the run's parent trace, carrying the leaf
   * data the orchestrator passes through from the migrated callers. The whole run is sampled or
   * dropped as a unit (binary, keyed on runId) so there are no partial trees. No-op when disabled or
   * unsampled; never throws (ADR-0021).
   */
  span(input: ResearchSpanInput): void {
    try {
      // Cheap gate first: skip all per-call work (uuids, timestamps) when tracing is off.
      if (!this.enabled) return;
      if (!this.ingest.shouldSample(input.runId, sampleRate())) return;

      const endTime = new Date().toISOString();
      const startTime = new Date(Date.parse(endTime) - (input.latencyMs ?? 0)).toISOString();
      const usage = compactUsage(input.usage);

      // Every research span is a GENERATION — each wraps an LLM call (gate/extract/dedup all hit the
      // model). generation-create maps model/usage so Langfuse can cost the call; span-create cannot.
      const body: Record<string, unknown> & { id: string } = {
        id: `${input.runId}-${input.span}-${crypto.randomUUID()}`,
        traceId: input.runId,
        name: input.span,
        startTime,
        endTime,
        // On-infra retention is permitted here (ADR-0017): the worker reads only public papers, never
        // end-user content, so there is nothing to redact.
        input: input.input,
        output: input.output,
        metadata: {
          latencyMs: input.latencyMs ?? 0,
          ...(input.metadata ?? {}),
        },
      };
      if (input.model) body.model = input.model;
      if (usage) body.usage = usage;

      this.ingest.post('research-span', {
        batch: [
          this.traceEvent(input.runId),
          {
            id: crypto.randomUUID(),
            type: 'generation-create',
            timestamp: endTime,
            body,
          },
        ],
      });
    } catch (err) {
      this.log.info(`research tracer span threw: ${err}`);
    }
  }

  // The content-free parent trace-create event, identical for every span of a run → repeated emits
  // upsert one trace. Named "run" (the research worker's unit), mirroring the bot's "turn".
  private traceEvent(runId: string, metadata?: Record<string, unknown>): {
    id: string;
    type: 'trace-create';
    timestamp: string;
    body: Record<string, unknown> & { id: string };
  } {
    return {
      id: crypto.randomUUID(),
      type: 'trace-create',
      timestamp: new Date().toISOString(),
      body: { id: runId, name: 'run', ...(metadata ? { metadata } : {}) },
    };
  }

  // Flush in-flight ingestion before the process exits so the last spans before a redeploy/SIGTERM
  // are not lost. Delegates to the kernel, which races the deadline and swallows failures so a flush
  // error can never block shutdown (ADR-0021). No-op when nothing is in flight (e.g. disabled tracer).
  async onApplicationShutdown(): Promise<void> {
    await this.ingest.flush(flushTimeoutMs());
  }
}
