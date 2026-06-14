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
  // Local-dev escape hatch (ADR-0024 relaxed when NODE_ENV !== 'production'): when true, crisis content
  // is retained for local debugging instead of dropped. Resolved by the caller from env — kept out of
  // this pure module. Defaults to undefined (= drop), so prod and all existing call sites stay safe.
  allowCrisis?: boolean;
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

// First-class Langfuse ingestion event types. We deliberately do NOT use the generic `observation-create`
// (LegacyObservationBody): its legacy converter carries model/usage but silently DROPS input/output/
// metadata. span-create / generation-create are the SDK's own events and map every field correctly.
export type IngestionEventType = 'trace-create' | 'span-create' | 'generation-create';

export interface IngestionEvent {
  id: string;
  type: IngestionEventType;
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
 * child observation (`span-create`, or `generation-create` for the coach) nested under it via traceId.
 * The parent carries no content, so the upsert is stable and verbatim text lives only on the spans.
 */
export class TracePayloadBuilder {
  build(spec: SpanSpec): IngestionEnvelope | null {
    if (!spec.enabled) return null;
    // Crisis content is dropped (ADR-0024) UNLESS the caller opted into local-dev full fidelity.
    if (spec.isCrisis && !spec.allowCrisis) return null;
    if (!spec.sampled) return null;

    // Langfuse usage shape. Include only the token fields the provider actually returned — an omitted
    // count must read as absent, never as 0. No fields → no usage block at all.
    const usage = compactUsage(spec.usage, { input: 'input', output: 'output' });

    // Native start/end so Langfuse computes the observation's own latency (its `latency` field). Derived
    // from the injected timestamp (= when the op finished) minus its measured duration — no ambient clock.
    const endTime = spec.timestamp;
    const startTime = new Date(Date.parse(spec.timestamp) - (spec.latencyMs ?? 0)).toISOString();

    const isGeneration = GENERATION_SPANS.has(spec.span);

    // span-create vs generation-create — chosen by the span's identity (see GENERATION_SPANS), never
    // inferred from whether a model id / usage happened to be present, so the coach span is always costed.
    const body: Record<string, unknown> & { id: string } = {
      id: `${spec.traceId}-${spec.span}`,
      traceId: spec.traceId,
      name: spec.span,
      startTime,
      endTime,
      // Non-crisis coaching content is retained in full for eval/quality data (ADR-0024). Scoped
      // exception to ADR-0013, permitted only because Langfuse is self-hosted/on-infra (ADR-0017).
      input: spec.input,
      output: spec.output,
      metadata: {
        latencyMs: spec.latencyMs ?? 0,
        // Present only for the intent step; lets the dispatch threshold (θ) be tuned from traces.
        ...(spec.confidence !== undefined ? { confidence: spec.confidence } : {}),
        // Counts/scores/ids for retrieval & memory spans — never verbatim text (ADR-0013).
        ...(spec.metadata ?? {}),
      },
    };
    // model/usage belong only on a generation body (CreateSpanBody has no such fields).
    if (isGeneration) {
      if (spec.model) body.model = spec.model;
      if (usage) body.usage = usage;
    }

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
          type: isGeneration ? 'generation-create' : 'span-create',
          timestamp: spec.timestamp,
          body,
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
