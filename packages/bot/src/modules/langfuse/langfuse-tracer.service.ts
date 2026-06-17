import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { LangfuseIngest } from '@wabi/shared/langfuse';
import {
  startObservation,
  isDefaultExportSpan,
  type ShouldExportSpan,
} from '@wabi/shared/otel';
import { JsonLogger } from '../../lib/json-logger';
import { TracePayloadBuilder, SpanName } from './trace-payload-builder';

export type { SpanName } from './trace-payload-builder';

export interface SpanInput {
  traceId: string;
  span: SpanName;
  input: string;
  output: string;
  isCrisis?: boolean;
  latencyMs?: number;
  confidence?: number;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  metadata?: Record<string, unknown>;
}

// One above-/below-gate child observation under the active `turn` root, emitted via the Langfuse OTEL
// SDK (ADR-0038). Crisis suppression is NOT applied here — it is centralized at export by
// `shouldExportSpan` keyed on the latched trace id, so a crisis turn drops its ENTIRE tree.
export interface ObservationInput {
  name: SpanName;
  input: string;
  output: string;
  // 'generation' for LLM leaves (classify/intent/coach) so model/usage render; 'span' otherwise.
  kind: 'generation' | 'span';
  latencyMs?: number;
  confidence?: number;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  metadata?: Record<string, unknown>;
}

// Dev keeps full visibility (sample everything); prod samples 10%. Read per-call from env so it
// tracks the running environment rather than import-time state. LANGFUSE_SAMPLE_RATE overrides both.
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

// Backstop on the crisis latch set so it cannot grow unbounded across the process lifetime.
const MAX_CRISIS_TURNS = 10000;

@Injectable()
export class LangfuseTracer implements OnApplicationShutdown {
  private readonly logger = new JsonLogger(LangfuseTracer.name);
  private readonly builder = new TracePayloadBuilder();
  // The shared, content-AGNOSTIC transport kernel (ADR-0037). It owns enablement, per-traceId
  // sampling, the in-flight POST set + cap, and the flush deadline race. The bot keeps the Wellbeing
  // policy on top: span vocabulary, the crisis latch, and content redaction (ADR-0013/0024).
  private readonly ingest = new LangfuseIngest({ warn: (m) => this.logger.warn(m) });
  // TraceIds latched as crisis: once any span of a turn is flagged crisis, EVERY later span/score for
  // that turn is suppressed centrally — a new call site that forgets isCrisis can't leak crisis content
  // (ADR-0021/0024). The per-span isCrisis flag and the builder's drop are belt-and-suspenders on top.
  private readonly crisisTurns = new Set<string>();

  // Evaluated per-call by the kernel, NOT cached: the tracer can be constructed before ConfigModule
  // populates process.env, which froze `enabled` to false and silently disabled tracing forever
  // (same load-order trap as @wabi/shared getProvider).
  private get enabled(): boolean {
    return this.ingest.enabled;
  }

  // Local-dev full fidelity: outside production, redaction is relaxed so traces carry crisis content
  // (ADR-0024) and verbatim retrieval/memory text (ADR-0013) for debugging. Read per-call from env —
  // same lazy-getter rule as `enabled` — and exposed publicly so the retrieval/memory call sites gate
  // their own (call-site-redacted) text against the SAME decision. Production keeps the full redaction.
  get localFullFidelity(): boolean {
    return process.env.NODE_ENV !== 'production';
  }

  // Per-call (lazy) so it tracks the running environment, never import-time state.
  private get isProd(): boolean {
    return process.env.NODE_ENV === 'production';
  }

  // The crisis backstop for the OTEL export plane (ADR-0024). Passed into createLangfuseTracing so the
  // LangfuseSpanProcessor consults it at span end: keep only spans the default filter would keep (Langfuse
  // / GenAI / known LLM instrumentor) AND — in production — whose trace is NOT crisis-latched. Because the
  // drop is keyed on trace id, a crisis turn drops its ENTIRE tree (root included). Outside production
  // (localFullFidelity) crisis traces are retained for classifier debugging. Bound arrow so `this` survives
  // being passed by reference. No `mask`: we drop, never redact-in-place.
  readonly shouldExportSpan: ShouldExportSpan = ({ otelSpan }) =>
    isDefaultExportSpan(otelSpan) &&
    !(this.isProd && this.crisisTurns.has(otelSpan.spanContext().traceId));

  // Emit a content-bearing child observation under the currently-active `turn` (ADR-0038). Fail-open:
  // tracing must never break the hot path (ADR-0021). Crisis content is contained by the latch +
  // shouldExportSpan drop above, NOT by suppressing emission here.
  traceObservation(params: ObservationInput): void {
    try {
      const { name, input, output, kind, latencyMs, confidence, model, usage, metadata } = params;
      // Backdate the start so the span's duration reflects the measured op latency.
      const startTime = latencyMs != null ? new Date(Date.now() - latencyMs) : undefined;
      const md: Record<string, unknown> = { ...(metadata ?? {}) };
      if (confidence != null) md.confidence = confidence;
      if (latencyMs != null) md.latencyMs = latencyMs;

      const attributes: Record<string, unknown> = { input, output, metadata: md };
      if (kind === 'generation') {
        if (model) attributes.model = model;
        if (usage) attributes.usageDetails = { input: usage.inputTokens, output: usage.outputTokens };
      }

      // Branch so each call site passes a literal asType (the SDK overloads are discriminated on it).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const attrs = attributes as any;
      const obs =
        kind === 'generation'
          ? startObservation(name, attrs, { asType: 'generation', startTime })
          : startObservation(name, attrs, { asType: 'span', startTime });
      obs.end();
    } catch {
      // fail-open
    }
  }

  // A coaching turn is one trace tree: each call adds one child span under the turn's parent trace.
  // Sampling is decided once per turn (binary, keyed on traceId) so every span of a turn is kept or
  // dropped together — no partial trees. The builder returns null when the turn must not be sent
  // (disabled / unsampled / crisis); no content-bearing payload is constructed or posted in that case.
  span(params: SpanInput): void {
    const local = this.localFullFidelity;
    // Latch the turn as crisis on the first crisis span, then suppress every span of a crisis turn.
    // Skipped in local full fidelity: there we WANT the whole crisis turn traced (latch + suppress
    // are the prod safety belt-and-suspenders, not a dev behaviour).
    if (!local) {
      if (params.isCrisis) this.latchCrisis(params.traceId);
      if (this.crisisTurns.has(params.traceId)) return;
    }
    // Cheap gate first: skip all per-call work (UUIDs, timestamp, sample hash) when tracing is off.
    if (!this.enabled) return;

    const envelope = this.builder.build({
      allowCrisis: local,
      traceId: params.traceId,
      span: params.span,
      input: params.input,
      output: params.output,
      enabled: this.enabled,
      sampled: this.ingest.shouldSample(params.traceId, sampleRate()),
      isCrisis: params.isCrisis,
      latencyMs: params.latencyMs,
      confidence: params.confidence,
      model: params.model,
      usage: params.usage,
      metadata: params.metadata,
      parentEventId: crypto.randomUUID(),
      spanEventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    });
    if (!envelope) return;

    this.ingest.post('span', { batch: envelope.batch });
  }

  score(
    traceId: string,
    name: string,
    value: number,
    isCrisis?: boolean,
  ): void {
    if (!this.localFullFidelity) {
      if (isCrisis) this.latchCrisis(traceId);
      if (this.crisisTurns.has(traceId)) return;
    }
    if (!this.enabled) return;

    // Full-fidelity, NOT span-sampled: aggregate quality/SLA rates need every turn, and a score is
    // content-free so there is no privacy/volume reason to drop it. The content-free parent trace is
    // upserted alongside so the score is never orphaned on a turn whose content spans were sampled out.
    const timestamp = new Date().toISOString();
    this.ingest.post('score-create', {
      batch: [
        {
          id: crypto.randomUUID(),
          type: 'trace-create',
          timestamp,
          body: { id: traceId, name: 'turn' },
        },
        {
          id: crypto.randomUUID(),
          type: 'score-create',
          timestamp,
          body: { id: `${traceId}-${name}`, traceId, name, value, dataType: 'NUMERIC' },
        },
      ],
    });
  }

  // Latch a turn as crisis (bounded FIFO so it can't grow unbounded over the process lifetime). Public
  // so the orchestrator can latch SYNCHRONOUSLY at the `classification === 'crisis'` short-circuit —
  // before any span of the turn ends — guaranteeing the export-time drop sees the latch (ADR-0024).
  latchCrisis(traceId: string): void {
    if (this.crisisTurns.has(traceId)) return;
    if (this.crisisTurns.size >= MAX_CRISIS_TURNS) {
      const oldest = this.crisisTurns.values().next().value;
      if (oldest !== undefined) this.crisisTurns.delete(oldest);
    }
    this.crisisTurns.add(traceId);
  }

  // Whether a turn is crisis-latched. Exposed for the regression suite around the bounded set.
  isCrisisLatched(traceId: string): boolean {
    return this.crisisTurns.has(traceId);
  }

  // Flush in-flight ingestion before the process exits so the last turns before a redeploy/SIGTERM
  // are not lost. Delegates to the kernel, which races the deadline and swallows failures so a flush
  // error can never block shutdown (ADR-0021). No-op when nothing is in flight (e.g. disabled tracer).
  async onApplicationShutdown(): Promise<void> {
    await this.ingest.flush(flushTimeoutMs());
  }
}
