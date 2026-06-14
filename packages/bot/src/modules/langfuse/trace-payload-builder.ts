// Single enumerated span vocabulary for a coaching turn. classify/intent/coach are wired now;
// retrieval/memory are wired in later slices. Call sites reference this union, never ad-hoc strings.
import { compactUsage } from '../../lib/usage';

export type SpanName = 'classify' | 'intent' | 'coach' | 'retrieval' | 'memory';

// Which span names are LLM generations (Langfuse computes cost only for GENERATION observations). The
// type is a property of WHICH step this is, declared here once — never inferred from whether a model
// id / usage block happened to be populated, which would silently demote a coach span on an error turn.
const GENERATION_SPANS: ReadonlySet<SpanName> = new Set<SpanName>(['coach']);

export interface SpanSpec {
  traceId: string;
  span: SpanName;
  input: string;
  output: string;
  // Resolved by the caller (LangfuseTracer) from env — kept out of this module so it stays pure.
  enabled: boolean;
  // Per-turn binary sampling decision (see shouldSample) — also resolved by the caller.
  sampled: boolean;
  isCrisis?: boolean;
  latencyMs?: number;
  confidence?: number;
  // Cost/identity signal for generation spans (coach). model id is always recorded when known;
  // token usage is recorded only when the provider returns it — never fabricated.
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  // Extra structured metadata for a span — counts / scores / ids only, never verbatim text (ADR-0013).
  // Merged into the span's metadata block alongside latencyMs.
  metadata?: Record<string, unknown>;
  // Injected so the builder has no ambient clock / randomness — keeps it deterministically testable.
  parentEventId: string;
  spanEventId: string;
  timestamp: string;
}

export interface IngestionEvent {
  id: string;
  type: 'trace-create' | 'observation-create';
  timestamp: string;
  body: Record<string, unknown> & { id: string };
}

export interface IngestionEnvelope {
  batch: IngestionEvent[];
}

/**
 * Pure builder for the Langfuse ingestion envelope. No process.env, no fetch, no clock — the caller
 * injects every environment-derived value (enabled, sampled, event ids, timestamp). Returns null when
 * the turn must not be sent: disabled tracer, unsampled turn, or crisis content (ADR-0024).
 *
 * A turn is one tree: a parent `trace-create` (upserted identically by every span of the turn) plus a
 * child `observation-create` span nested under it via traceId. The parent carries no content, so the
 * upsert is stable and verbatim text lives only on the spans.
 */
export class TracePayloadBuilder {
  build(spec: SpanSpec): IngestionEnvelope | null {
    if (!spec.enabled) return null;
    if (spec.isCrisis) return null;
    if (!spec.sampled) return null;

    // Langfuse usage shape. Include only the token fields the provider actually returned — an omitted
    // count must read as absent, never as 0. No fields → no usage block at all.
    const usage = compactUsage(spec.usage, { input: 'input', output: 'output' });

    return {
      batch: [
        {
          id: spec.parentEventId,
          type: 'trace-create',
          timestamp: spec.timestamp,
          // Content-free, identical for every span of the turn → repeated emits upsert one trace.
          body: { id: spec.traceId, name: 'turn' },
        },
        {
          id: spec.spanEventId,
          type: 'observation-create',
          timestamp: spec.timestamp,
          // Non-crisis coaching content is retained in full for eval/quality data (ADR-0024). Scoped
          // exception to ADR-0013, permitted only because Langfuse is self-hosted/on-infra (ADR-0017).
          body: {
            id: `${spec.traceId}-${spec.span}`,
            traceId: spec.traceId,
            // GENERATION vs SPAN is decided by the span's identity (see GENERATION_SPANS), not by whether
            // a model id / usage happened to be present — so a coach span on an error turn is still costed.
            type: GENERATION_SPANS.has(spec.span) ? 'GENERATION' : 'SPAN',
            name: spec.span,
            input: spec.input,
            output: spec.output,
            ...(spec.model ? { model: spec.model } : {}),
            ...(usage ? { usage } : {}),
            metadata: {
              latencyMs: spec.latencyMs ?? 0,
              // Present only for the intent step; lets the dispatch threshold (θ) be tuned from traces.
              ...(spec.confidence !== undefined ? { confidence: spec.confidence } : {}),
              // Counts/scores/ids for retrieval & memory spans — never verbatim text (ADR-0013).
              ...(spec.metadata ?? {}),
            },
          },
        },
      ],
    };
  }

  /**
   * Binary per-turn sampling decision, deterministic in traceId so every span of one turn agrees
   * (the whole turn is sampled or dropped as a unit — no partial trees). rate >= 1 always samples;
   * rate <= 0 never samples; otherwise a stable hash of traceId is compared against the rate.
   */
  shouldSample(traceId: string, rate: number): boolean {
    if (rate >= 1) return true;
    if (rate <= 0) return false;
    return hashUnit(traceId) < rate;
  }
}

// FNV-1a hash mapped into [0, 1). Stable across processes (no Math.random), so a turn's sampling
// decision is reproducible from its traceId alone.
function hashUnit(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}
