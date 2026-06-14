import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { safeFetch } from '../../lib/safe-fetch';
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

// Backstop on the awaited in-flight set: if Langfuse hangs under burst traffic, untracked POSTs still
// fire-and-forget, we just stop retaining their (content-bearing) bodies for the shutdown flush.
const MAX_INFLIGHT = 1000;
// Backstop on the crisis latch set so it cannot grow unbounded across the process lifetime.
const MAX_CRISIS_TURNS = 10000;

@Injectable()
export class LangfuseTracer implements OnApplicationShutdown {
  private readonly logger = new JsonLogger(LangfuseTracer.name);
  private readonly builder = new TracePayloadBuilder();
  // In-flight ingestion promises. The tracer is fire-and-forget, so without this the last turns
  // before a SIGTERM/redeploy would be orphaned mid-POST. onApplicationShutdown awaits these.
  private readonly inflight = new Set<Promise<unknown>>();
  // TraceIds latched as crisis: once any span of a turn is flagged crisis, EVERY later span/score for
  // that turn is suppressed centrally — a new call site that forgets isCrisis can't leak crisis content
  // (ADR-0021/0024). The per-span isCrisis flag and the builder's drop are belt-and-suspenders on top.
  private readonly crisisTurns = new Set<string>();

  // Evaluated per-call, NOT cached in the constructor: the tracer can be constructed before
  // ConfigModule populates process.env, which froze `enabled` to false and silently disabled
  // tracing forever (same load-order trap as @wabi/shared getProvider).
  private get enabled(): boolean {
    return !!(
      process.env.LANGFUSE_HOST &&
      process.env.LANGFUSE_PUBLIC_KEY &&
      process.env.LANGFUSE_SECRET_KEY
    );
  }

  // A coaching turn is one trace tree: each call adds one child span under the turn's parent trace.
  // Sampling is decided once per turn (binary, keyed on traceId) so every span of a turn is kept or
  // dropped together — no partial trees. The builder returns null when the turn must not be sent
  // (disabled / unsampled / crisis); no content-bearing payload is constructed or posted in that case.
  span(params: SpanInput): void {
    // Latch the turn as crisis on the first crisis span, then suppress every span of a crisis turn.
    if (params.isCrisis) this.latchCrisis(params.traceId);
    if (this.crisisTurns.has(params.traceId)) return;
    // Cheap gate first: skip all per-call work (UUIDs, timestamp, sample hash) when tracing is off.
    if (!this.enabled) return;

    const envelope = this.builder.build({
      traceId: params.traceId,
      span: params.span,
      input: params.input,
      output: params.output,
      enabled: this.enabled,
      sampled: this.builder.shouldSample(params.traceId, sampleRate()),
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

    this.post('span', { batch: envelope.batch });
  }

  score(
    traceId: string,
    name: string,
    value: number,
    isCrisis?: boolean,
  ): void {
    if (isCrisis) this.latchCrisis(traceId);
    if (this.crisisTurns.has(traceId)) return;
    if (!this.enabled) return;

    // Full-fidelity, NOT span-sampled: aggregate quality/SLA rates need every turn, and a score is
    // content-free so there is no privacy/volume reason to drop it. The content-free parent trace is
    // upserted alongside so the score is never orphaned on a turn whose content spans were sampled out.
    const timestamp = new Date().toISOString();
    this.post('score-create', {
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

  // Latch a turn as crisis (bounded so it can't grow unbounded over the process lifetime).
  private latchCrisis(traceId: string): void {
    if (this.crisisTurns.has(traceId)) return;
    if (this.crisisTurns.size >= MAX_CRISIS_TURNS) {
      const oldest = this.crisisTurns.values().next().value;
      if (oldest !== undefined) this.crisisTurns.delete(oldest);
    }
    this.crisisTurns.add(traceId);
  }

  // Langfuse ingestion API: POST /api/public/ingestion with HTTP Basic auth (public:secret) and a
  // batch envelope. All failures are swallowed and logged — tracing must never break the hot path
  // (ADR-0021).
  private post(label: string, envelope: { batch: unknown[] }): void {
    try {
      const host = process.env.LANGFUSE_HOST;
      const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
      const secretKey = process.env.LANGFUSE_SECRET_KEY;
      if (!host || !publicKey || !secretKey) return;

      const auth = Buffer.from(`${publicKey}:${secretKey}`).toString('base64');

      const pending = safeFetch(
        `${host}/api/public/ingestion`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${auth}`,
          },
          body: JSON.stringify(envelope),
        },
        (status, body) => {
          this.logger.warn(`Langfuse ingest ${label} -> HTTP ${status}: ${body}`);
        },
      ).catch((err) => this.logger.warn(`Langfuse ingest ${label} failed: ${err}`));

      // Track until settled so shutdown can flush it; the .catch above already swallows errors. Capped
      // so a hung Langfuse under burst traffic can't retain unbounded content-bearing bodies — over the
      // cap the POST still fires fire-and-forget, it's just not awaited at shutdown.
      if (this.inflight.size < MAX_INFLIGHT) {
        this.inflight.add(pending);
        void pending.finally(() => this.inflight.delete(pending));
      }
    } catch (err) {
      this.logger.warn(`Langfuse ingest ${label} threw: ${err}`);
    }
  }

  // Flush in-flight ingestion before the process exits so the last turns before a redeploy/SIGTERM
  // are not lost. Failure-isolated: a flush error is swallowed and must never block shutdown
  // (ADR-0021). No-op when nothing is in flight (e.g. disabled tracer).
  async onApplicationShutdown(): Promise<void> {
    if (this.inflight.size === 0) return;
    try {
      const settled = Promise.allSettled([...this.inflight]);
      // Race against a deadline: a Langfuse that accepts but never responds must not block exit.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, flushTimeoutMs());
      });
      await Promise.race([settled.then(() => undefined), deadline]);
      if (timer) clearTimeout(timer);
    } catch (err) {
      this.logger.warn(`Langfuse flush on shutdown failed: ${err}`);
    }
  }
}
