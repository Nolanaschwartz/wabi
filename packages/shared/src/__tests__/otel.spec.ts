import {
  createLangfuseTracing,
  createLangfuseScorer,
  startActiveObservation,
  getActiveTraceId,
} from '../otel';

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

  it('forwards a custom exporter and exports only spans passing shouldExportSpan, flushed on demand', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { InMemorySpanExporter } = require('@opentelemetry/sdk-trace-base');
    const exporter = new InMemorySpanExporter();
    const dropped = new Set<string>();

    const tracing = createLangfuseTracing({
      serviceName: 'wabi-test',
      sampleRate: 1,
      exporter,
      shouldExportSpan: ({ otelSpan }) => !dropped.has(otelSpan.spanContext().traceId),
    });

    const keep = tracing.tracer.startSpan('keep');
    keep.end();

    const drop = tracing.tracer.startSpan('drop');
    dropped.add(drop.spanContext().traceId);
    drop.end();

    await tracing.forceFlush();

    const names = exporter.getFinishedSpans().map((s: { name: string }) => s.name);
    expect(names).toContain('keep');
    expect(names).not.toContain('drop');
  });

  it('produces valid (non-zero) trace ids even when degraded, for log correlation', () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;

    const tracing = createLangfuseTracing({ serviceName: 'wabi-bot', sampleRate: 1 });
    const traceId = tracing.tracer.startSpan('turn').spanContext().traceId;

    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(traceId).not.toBe('0'.repeat(32));
  });

  it('enables active-span propagation: getActiveTraceId works inside startActiveObservation', async () => {
    // Regression: without a global ContextManager the active span never propagates, so
    // getActiveTraceId returns undefined and child observations split into separate traces.
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';
    const tracing = createLangfuseTracing({
      serviceName: 'wabi-bot',
      sampleRate: 1,
      shouldExportSpan: () => false,
    });

    let active: string | undefined;
    await startActiveObservation('turn', async () => {
      active = getActiveTraceId();
    });

    expect(active).toMatch(/^[0-9a-f]{32}$/);
    await tracing.shutdown(200);
  });
});

describe('createLangfuseScorer', () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('emits a NUMERIC score keyed on `${traceId}-${name}` for idempotency', () => {
    const create = jest.fn();
    const client = { score: { create }, flush: jest.fn().mockResolvedValue(undefined) };

    const scorer = createLangfuseScorer({ client });
    scorer.score({ traceId: 'trace-1', name: 'latency_sla', value: 1 });

    expect(create).toHaveBeenCalledWith({
      id: 'trace-1-latency_sla',
      traceId: 'trace-1',
      name: 'latency_sla',
      value: 1,
      dataType: 'NUMERIC',
    });
  });

  it('flush delegates to the client', async () => {
    const flush = jest.fn().mockResolvedValue(undefined);
    const scorer = createLangfuseScorer({ client: { score: { create: jest.fn() }, flush } });
    await scorer.flush();
    expect(flush).toHaveBeenCalled();
  });

  it('is fail-open: a client error never propagates', () => {
    const scorer = createLangfuseScorer({
      client: {
        score: {
          create: () => {
            throw new Error('langfuse down');
          },
        },
        flush: jest.fn().mockResolvedValue(undefined),
      },
    });
    expect(() => scorer.score({ traceId: 't', name: 'reply_present', value: 0 })).not.toThrow();
  });

  it('is a no-op when LANGFUSE_* creds are absent', async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    const scorer = createLangfuseScorer();
    expect(() => scorer.score({ traceId: 't', name: 'reply_present', value: 1 })).not.toThrow();
    await expect(scorer.flush()).resolves.toBeUndefined();
  });
});
