import { Injectable } from '@nestjs/common';
import {
  startObservation,
  isDefaultExportSpan,
  type ShouldExportSpan,
} from '@wabi/shared/otel';

/**
 * LangfuseTracer — the bot's Wellbeing-context tracing policy adapter (ADR-0038).
 *
 * Owns the crisis backstop (the latched-trace-id `shouldExportSpan` drop) and the span vocabulary for
 * above-/below-gate observations. The transport/mechanism now lives entirely in the Langfuse OTEL SDK
 * (`@wabi/shared/otel`); this class adds only the per-context safety policy (ADR-0013/0021/0024).
 */

// The bot's span vocabulary — one enumerated union, never ad-hoc strings at call sites.
export type SpanName = 'classify' | 'intent' | 'retrieval' | 'memory' | 'coach';

// One above-/below-gate child observation under the active `turn` root, emitted via the Langfuse OTEL
// SDK. Crisis suppression is NOT applied here — it is centralized at export by `shouldExportSpan` keyed
// on the latched trace id, so a crisis turn drops its ENTIRE tree.
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

// Backstop on the crisis latch set so it cannot grow unbounded across the process lifetime.
const MAX_CRISIS_TURNS = 10000;

@Injectable()
export class LangfuseTracer {
  // TraceIds latched as crisis: once a turn's verdict is crisis, EVERY span of that turn is dropped at
  // export in production — a new call site can't leak crisis content (ADR-0021/0024).
  private readonly crisisTurns = new Set<string>();

  // Local-dev full fidelity: outside production, redaction is relaxed so traces carry crisis content
  // (ADR-0024) and verbatim retrieval/memory text (ADR-0013) for debugging. Read per-call from env so it
  // tracks the running environment; exposed publicly so the retrieval/memory call sites gate their own
  // (call-site-redacted) text against the SAME decision. Production keeps the full redaction.
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
}
