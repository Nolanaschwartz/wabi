import { createLangfuseTracing } from '../otel';

describe('createLangfuseTracing', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('is fail-open when LANGFUSE_* is absent: returns a working no-op handle', async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;

    const tracing = createLangfuseTracing({ serviceName: 'wabi-test', sampleRate: 1 });

    // The tracer is usable: starting and ending a span must never throw.
    const span = tracing.tracer.startSpan('turn');
    expect(() => span.end()).not.toThrow();

    // shutdown resolves cleanly.
    await expect(tracing.shutdown()).resolves.toBeUndefined();
  });

  it('builds a real handle when LANGFUSE_* creds are present', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';
    process.env.LANGFUSE_BASE_URL = 'http://localhost:3999';

    const tracing = createLangfuseTracing({
      serviceName: 'wabi-bot',
      sampleRate: 1,
      shouldExportSpan: () => false, // offline-safe: no export attempt to a dead host
    });

    const span = tracing.tracer.startSpan('turn');
    expect(() => span.end()).not.toThrow();

    // shutdown is bounded: it resolves cleanly.
    await expect(tracing.shutdown(200)).resolves.toBeUndefined();
  });

  it('honors the shouldExportSpan hook for spans it processes', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';
    process.env.LANGFUSE_BASE_URL = 'http://localhost:3999';

    const seen: string[] = [];
    const shouldExportSpan = jest.fn(({ otelSpan }) => {
      seen.push(otelSpan.name);
      return false; // drop — keeps the test offline-safe (no export attempt)
    });

    const tracing = createLangfuseTracing({
      serviceName: 'wabi-bot',
      sampleRate: 1,
      shouldExportSpan,
    });

    tracing.tracer.startSpan('turn').end();
    await tracing.shutdown(200);

    expect(shouldExportSpan).toHaveBeenCalled();
    expect(seen).toContain('turn');
  });

  it('produces valid (non-zero) trace ids even when degraded, for log correlation', () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;

    const tracing = createLangfuseTracing({ serviceName: 'wabi-bot', sampleRate: 1 });
    const traceId = tracing.tracer.startSpan('turn').spanContext().traceId;

    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(traceId).not.toBe('0'.repeat(32));
  });
});
