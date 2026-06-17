import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { createLangfuseTracing, type LangfuseTracing } from '@wabi/shared/otel';
import { JsonLogger } from '../../lib/json-logger';

// Dev keeps full visibility (sample everything); prod samples 10%. Read per-call from env so it tracks
// the running environment rather than import-time state. LANGFUSE_SAMPLE_RATE overrides both. Mirrors
// the legacy LangfuseTracer sampler so the OTEL trace id and the old kernel agree on per-turn sampling.
function resolveSampleRate(): number {
  const override = process.env.LANGFUSE_SAMPLE_RATE;
  if (override !== undefined && override !== '') {
    const parsed = Number(override);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return process.env.NODE_ENV === 'production' ? 0.1 : 1.0;
}

// How long shutdown waits for in-flight spans to flush before giving up. A Langfuse that accepts the
// connection but never responds must not block process exit indefinitely (ADR-0021).
function flushTimeoutMs(): number {
  const parsed = Number(process.env.LANGFUSE_FLUSH_TIMEOUT_MS);
  return Number.isNaN(parsed) || parsed <= 0 ? 5000 : parsed;
}

/**
 * Bootstraps the isolated Langfuse OpenTelemetry provider for the bot (ADR-0038).
 *
 * The provider is built in the constructor, which Nest runs AFTER `ConfigModule` has populated
 * `process.env` — the same lazy-init discipline as `getProvider`/`LangfuseTracer`, avoiding the
 * import-order trap that would otherwise freeze tracing to a degraded state. Building it calls
 * `setLangfuseTracerProvider`, so every `startActiveObservation` across the bot routes to this
 * isolated provider and never to Sentry's global one. Fail-open: degraded creds yield a handle that
 * still mints valid trace ids but exports nothing.
 */
@Injectable()
export class OtelTracingService implements OnApplicationShutdown {
  private readonly logger = new JsonLogger(OtelTracingService.name);

  private readonly tracing: LangfuseTracing = createLangfuseTracing({
    serviceName: 'wabi-bot',
    sampleRate: resolveSampleRate(),
  });

  async onApplicationShutdown(): Promise<void> {
    await this.tracing.shutdown(flushTimeoutMs());
  }
}
