import { trace, context, type Tracer } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { TraceIdRatioBasedSampler, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { LangfuseSpanProcessor, type ShouldExportSpan } from '@langfuse/otel';
import { setLangfuseTracerProvider } from '@langfuse/tracing';
import { LangfuseClient } from '@langfuse/client';

// Re-export the manual-tracing helpers through this single seam so the rest of the monorepo never
// imports `@langfuse/*` directly — keeping the OpenTelemetry dependency isolated behind `./otel`.
export { startActiveObservation, startObservation, getActiveTraceId } from '@langfuse/tracing';
export { isDefaultExportSpan } from '@langfuse/otel';
export type { ShouldExportSpan } from '@langfuse/otel';
export type { Tracer, SpanContext } from '@opentelemetry/api';

/**
 * Content-agnostic Langfuse OpenTelemetry tracing bootstrap (ADR-0038).
 *
 * Builds an **isolated** `NodeTracerProvider` — never the global one — so Sentry's
 * global OTEL provider is left untouched and there is no import-order constraint.
 * Init is **fail-open** (ADR-0021): missing `LANGFUSE_*` creds or any construction
 * error yields a no-op handle; tracing never breaks boot or the hot path.
 *
 * This module is deliberately NOT re-exported from the barrel `index.ts` so the
 * OpenTelemetry dependency stays off `@wabi/web`'s bundle.
 */
export interface LangfuseTracing {
  /** Tracer bound to the isolated provider (or the global no-op tracer when degraded). */
  tracer: Tracer;
  /** Flush in-flight spans to the exporter without tearing down. Always resolves; never throws. */
  forceFlush(): Promise<void>;
  /** Flush in-flight spans and tear the provider down. Always resolves; never throws. */
  shutdown(timeoutMs?: number): Promise<void>;
}

export interface CreateLangfuseTracingOptions {
  /** Tracer name, e.g. 'wabi-bot' | 'wabi-research'. */
  serviceName: string;
  /** Head sampling rate for the `TraceIdRatioBasedSampler` (deterministic per trace id). */
  sampleRate: number;
  /** Per-span export filter (e.g. crisis backstop). Forwarded to `LangfuseSpanProcessor`. */
  shouldExportSpan?: ShouldExportSpan;
  /** Override the OTLP exporter (e.g. an in-memory exporter under test). */
  exporter?: SpanExporter;
}

function noopHandle(serviceName: string): LangfuseTracing {
  // The global API tracer creates non-recording spans when no provider is registered.
  return { tracer: trace.getTracer(serviceName), forceFlush: async () => {}, shutdown: async () => {} };
}

/**
 * The self-hosted Langfuse base URL. Wabi configures the self-hosted instance via `LANGFUSE_HOST`, but
 * the Langfuse v5 SDK only reads `LANGFUSE_BASE_URL`/`LANGFUSE_BASEURL` and otherwise defaults to
 * `https://cloud.langfuse.com`. Resolve `LANGFUSE_HOST` FIRST so personal data never egresses to the
 * public cloud (privacy by construction, ADR-0002/0017). Returns undefined when no self-hosted host is
 * configured — callers treat that as "do not export" rather than silently falling back to the cloud.
 */
export function resolveLangfuseBaseUrl(): string | undefined {
  return process.env.LANGFUSE_HOST || process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_BASEURL || undefined;
}

export function createLangfuseTracing(opts: CreateLangfuseTracingOptions): LangfuseTracing {
  const { serviceName, sampleRate, shouldExportSpan, exporter } = opts;

  // We always build a real isolated provider (real, non-zero OTEL trace ids for log correlation),
  // even when degraded. The exporting `LangfuseSpanProcessor` is attached only when creds AND an
  // explicit self-hosted base URL are present — never the SDK's cloud.langfuse.com default, which would
  // egress personal data (ADR-0002/0017). Without the processor, spans get valid ids and a deterministic
  // sampling decision but are never exported. Fail-open (ADR-0021).
  const baseUrl = resolveLangfuseBaseUrl();
  const hasCreds =
    !!process.env.LANGFUSE_PUBLIC_KEY && !!process.env.LANGFUSE_SECRET_KEY && !!baseUrl;

  try {
    // Active-span propagation (so startActiveObservation makes the `turn` active and children nest
    // under it) needs a global ContextManager. Sentry registers one at init in prod; setGlobalContextManager
    // is a no-op when one already exists, so this never clobbers Sentry — it only fills the gap when Sentry
    // is absent (tests, Sentry off), keeping trace nesting correct everywhere.
    const contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);

    const spanProcessors = hasCreds
      ? [new LangfuseSpanProcessor({ shouldExportSpan, exporter, baseUrl })]
      : [];
    const provider = new NodeTracerProvider({
      // Stamp service.name on the Resource so traces are attributed to 'wabi-bot'/'wabi-research'
      // instead of OTEL's `unknown_service:node` default.
      resource: resourceFromAttributes({ 'service.name': serviceName }),
      sampler: new TraceIdRatioBasedSampler(sampleRate),
      spanProcessors,
    });
    setLangfuseTracerProvider(provider);

    return {
      tracer: provider.getTracer(serviceName),
      forceFlush: async () => {
        try {
          await provider.forceFlush();
        } catch {
          // fail-open: a flush failure must never break the caller.
        }
      },
      shutdown: async (timeoutMs = 2000) => {
        try {
          await Promise.race([
            provider.shutdown(),
            new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
          ]);
        } catch {
          // fail-open: a flush/shutdown failure must never break process teardown.
        }
      },
    };
  } catch {
    // Truly exceptional (provider construction failed) — fall back to the global no-op tracer.
    return noopHandle(serviceName);
  }
}

/**
 * Content-free per-turn quality scoring via the official `@langfuse/client` (ADR-0038).
 *
 * Scores post to the scores endpoint independent of the span sampler, so every turn is scored even
 * when its spans are sampled out — aggregate SLA/quality rates (the ADR-0014 purpose) stay complete.
 * They are emitted below the crisis gate (inherently non-crisis), so no crisis gating is needed here.
 * The `id` (`${traceId}-${name}`) preserves idempotency. Fail-open (ADR-0021): missing creds/base URL
 * or any error yields a no-op scorer.
 *
 * KNOWN LIMITATION (by design): under prod head sampling (~10%), a score may reference a trace whose
 * spans were sampled out, so its Langfuse UI drill-through is empty. This is cosmetic — scores live in
 * their own store and aggregate independently of trace ingestion. A content-free trace upsert is not
 * re-introduced because v5 has no cheap client-side trace create (traces are born from exported spans);
 * fixing drill-through would require a sampling redesign (always-export content-free roots), out of scope.
 */
export interface LangfuseScorer {
  score(params: { traceId: string; name: string; value: number }): void;
  flush(): Promise<void>;
}

// Minimal structural seam over LangfuseClient so a test can inject a fake and assert the emitted body.
export interface ScoreClientLike {
  score: {
    create(body: {
      id?: string;
      traceId?: string;
      name: string;
      value: number;
      dataType?: string;
    }): void;
  };
  flush(): Promise<void>;
}

export function createLangfuseScorer(opts?: { client?: ScoreClientLike }): LangfuseScorer {
  const noop: LangfuseScorer = { score: () => {}, flush: async () => {} };

  let client = opts?.client;
  if (!client) {
    // Same self-hosted gate as the span exporter: require creds AND an explicit base URL so scores never
    // post to the SDK's cloud.langfuse.com default (ADR-0002/0017).
    const baseUrl = resolveLangfuseBaseUrl();
    if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY || !baseUrl) return noop;
    try {
      client = new LangfuseClient({ baseUrl }) as unknown as ScoreClientLike;
    } catch {
      return noop;
    }
  }

  const c = client;
  return {
    score: ({ traceId, name, value }) => {
      try {
        c.score.create({ id: `${traceId}-${name}`, traceId, name, value, dataType: 'NUMERIC' });
      } catch {
        // fail-open: a scoring failure must never break the hot path.
      }
    },
    flush: async () => {
      try {
        await c.flush();
      } catch {
        // fail-open
      }
    },
  };
}
