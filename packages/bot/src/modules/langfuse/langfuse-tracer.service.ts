import { Injectable } from '@nestjs/common';

export type TraceStep = 'classify' | 'coach' | 'retrieval';

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

@Injectable()
export class LangfuseTracer {
  private enabled: boolean;

  constructor() {
    this.enabled = !!(
      process.env.LANGFUSE_HOST &&
      process.env.LANGFUSE_PUBLIC_KEY &&
      process.env.LANGFUSE_SECRET_KEY
    );
  }

  trace(
    traceId: string,
    step: TraceStep,
    input: string,
    output: string,
    options?: { isCrisis?: boolean; latencyMs?: number },
  ): void {
    if (!this.enabled) return;
    if (options?.isCrisis) return;

    const isSampled = Math.random() < sampleRate();
    const level = isSampled ? 'debug' : 'info';

    // Non-crisis coaching content is retained in full for eval/quality data (ADR-0024).
    // This is a scoped exception to ADR-0013 (no durable transcript store), permitted only
    // because Langfuse is self-hosted, single-tenant, and on-infra (ADR-0017). Crisis
    // traces are dropped entirely above (never reach here).
    this.ingest('trace-create', {
      id: `${traceId}-${step}`,
      name: step,
      input,
      output,
      level,
      metadata: {
        latencyMs: options?.latencyMs ?? 0,
        sampled: isSampled,
      },
    });
  }

  score(
    traceId: string,
    name: string,
    value: number,
    isCrisis?: boolean,
  ): void {
    if (!this.enabled) return;
    if (isCrisis) return;

    this.ingest('score-create', {
      id: `${traceId}-${name}`,
      traceId,
      name,
      value,
      dataType: 'NUMERIC',
    });
  }

  // Langfuse ingestion API: POST /api/public/ingestion with HTTP Basic auth (public:secret) and a
  // batch envelope. The prior implementation posted a flat object to /api/traces with an x-api-key
  // header — a 404 that silently dropped every trace.
  private ingest(type: 'trace-create' | 'score-create', body: Record<string, unknown>): void {
    try {
      const host = process.env.LANGFUSE_HOST;
      const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
      const secretKey = process.env.LANGFUSE_SECRET_KEY;
      if (!host || !publicKey || !secretKey) return;

      const auth = Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
      const event = {
        id: crypto.randomUUID(),
        type,
        timestamp: new Date().toISOString(),
        body,
      };

      fetch(`${host}/api/public/ingestion`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${auth}`,
        },
        body: JSON.stringify({ batch: [event] }),
      }).catch(() => {});
    } catch {
      // Best-effort tracing
    }
  }
}
