/**
 * LangfuseIngest — the CONTENT-AGNOSTIC Langfuse transport kernel (ADR-0037).
 *
 * This is the shared inference/tracing kernel: plain TypeScript, NO NestJS. It owns ONLY the
 * mechanics of getting an already-built batch envelope into Langfuse — it knows NOTHING about
 * crisis, coaching turns, span names, or redaction. Those are policy that stays per-context
 * (the bot's Wellbeing context owns the crisis latch + content redaction, ADR-0013/0024).
 *
 * Exposed via the `@wabi/shared/langfuse` subpath (mirroring `@wabi/shared/sentry-scrub`) so it
 * never drags the Prisma client (instantiated by the package barrel at import time) into a
 * consumer's bundle graph. It is deliberately NOT re-exported from src/index.ts.
 *
 * Responsibilities, all here and nowhere else:
 *   - lazy `enabled` env check (re-read process.env every access — never cached),
 *   - `shouldSample(traceId, rate)`: deterministic binary per-traceId sampling,
 *   - the batch-envelope POST with its in-flight set + MAX_INFLIGHT cap,
 *   - `flush(timeoutMs)`: await in-flight, racing a deadline so a hung Langfuse can't block exit.
 *
 * Every failure is swallowed and logged — tracing must NEVER break the hot path (ADR-0021).
 */

/** The shape this kernel transports. Content is opaque to the kernel — the caller builds it. */
export interface IngestEnvelope {
  batch: unknown[];
}

/** Minimal logger seam so the bot can hand its JsonLogger in; defaults to console. */
export interface IngestLogger {
  warn(message: string): void;
}

export class LangfuseIngest {
  // Backstop on the awaited in-flight set: if Langfuse hangs under burst traffic, untracked POSTs
  // still fire-and-forget — we just stop retaining their (content-bearing) bodies for the flush.
  static readonly MAX_INFLIGHT = 1000;

  private readonly logger: IngestLogger;
  // In-flight ingestion promises. The transport is fire-and-forget, so without this the last
  // POSTs before a SIGTERM/redeploy would be orphaned mid-flight. flush() awaits these.
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(logger: IngestLogger = { warn: (m) => console.warn(m) }) {
    this.logger = logger;
  }

  /**
   * Evaluated per access, NOT cached: the kernel can be constructed before the process's config
   * populates process.env, which would freeze `enabled` to false and silently disable tracing
   * forever (the same load-order trap as @wabi/shared getProvider).
   */
  get enabled(): boolean {
    return !!(
      process.env.LANGFUSE_HOST &&
      process.env.LANGFUSE_PUBLIC_KEY &&
      process.env.LANGFUSE_SECRET_KEY
    );
  }

  /** Number of currently-awaited in-flight POSTs (capped at MAX_INFLIGHT). Exposed for tests. */
  get inflightSize(): number {
    return this.inflight.size;
  }

  /**
   * Binary per-traceId sampling decision, deterministic in traceId so every caller asking about
   * one trace agrees (the whole trace is sampled or dropped as a unit — no partial trees).
   * rate >= 1 always samples; rate <= 0 never samples; otherwise a stable hash of traceId is
   * compared against the rate. No Math.random — reproducible from the traceId alone.
   */
  shouldSample(traceId: string, rate: number): boolean {
    if (rate >= 1) return true;
    if (rate <= 0) return false;
    return hashUnit(traceId) < rate;
  }

  /**
   * POST a batch envelope to Langfuse's ingestion API with HTTP Basic auth (public:secret).
   * Fire-and-forget: the returned promise is tracked (up to MAX_INFLIGHT) so flush() can await it,
   * never awaited by the caller. All failures are swallowed and logged (ADR-0021). No-op when the
   * tracer is disabled — no fetch is issued.
   */
  post(label: string, envelope: IngestEnvelope): void {
    try {
      const host = process.env.LANGFUSE_HOST;
      const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
      const secretKey = process.env.LANGFUSE_SECRET_KEY;
      if (!host || !publicKey || !secretKey) return;

      const auth = Buffer.from(`${publicKey}:${secretKey}`).toString('base64');

      const pending = fetch(`${host}/api/public/ingestion`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${auth}`,
        },
        body: JSON.stringify(envelope),
      })
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            this.logger.warn(`Langfuse ingest ${label} -> HTTP ${res.status}: ${body.slice(0, 200)}`);
          }
        })
        .catch((err) => this.logger.warn(`Langfuse ingest ${label} failed: ${err}`));

      // Track until settled so flush can await it; the .catch above already swallows errors. Capped
      // so a hung Langfuse under burst traffic can't retain unbounded content-bearing bodies — over
      // the cap the POST still fires fire-and-forget, it's just not awaited at flush.
      if (this.inflight.size < LangfuseIngest.MAX_INFLIGHT) {
        this.inflight.add(pending);
        void pending.finally(() => this.inflight.delete(pending));
      }
    } catch (err) {
      this.logger.warn(`Langfuse ingest ${label} threw: ${err}`);
    }
  }

  /**
   * Flush in-flight ingestion before the process exits so the last POSTs before a redeploy/SIGTERM
   * are not lost. Races a deadline: a Langfuse that accepts the connection but never responds must
   * not block exit indefinitely (ADR-0021). Failure-isolated — a flush error is swallowed and never
   * blocks shutdown. No-op when nothing is in flight (e.g. disabled kernel).
   */
  async flush(timeoutMs: number): Promise<void> {
    if (this.inflight.size === 0) return;
    try {
      const settled = Promise.allSettled([...this.inflight]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs > 0 ? timeoutMs : 0);
      });
      await Promise.race([settled.then(() => undefined), deadline]);
      if (timer) clearTimeout(timer);
    } catch (err) {
      this.logger.warn(`Langfuse flush failed: ${err}`);
    }
  }
}

// FNV-1a hash mapped into [0, 1). Stable across processes (no Math.random), so a trace's sampling
// decision is reproducible from its traceId alone.
function hashUnit(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}
