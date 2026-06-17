import { ResearchTracer, type ResearchSpanName } from '../research-tracer';

/**
 * ResearchTracer is now a thin adapter over the Langfuse OpenTelemetry SDK (ADR-0038): it owns only
 * the run/paper span vocabulary and carries NO crisis latch and NO redaction (the worker handles no
 * end-user content). Behaviour risk is low, so this is a smoke test — it proves the adapter constructs,
 * emits the run + every paper span, and shuts down without ever throwing (tracing must never break a
 * run, ADR-0021). The full export path is covered by @wabi/shared's createLangfuseTracing suite.
 */
describe('ResearchTracer (smoke)', () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const silentLog = { info: jest.fn(), debug: jest.fn(), error: jest.fn() } as any;

  it('constructs, emits a run + gate/extract/dedup spans, and shuts down without throwing (degraded)', async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;

    const tracer = new ResearchTracer(silentLog);

    expect(() => tracer.run({ runId: 'run-1', metadata: { topic: 'sleep hygiene' } })).not.toThrow();
    for (const span of ['gate', 'extract', 'dedup'] as ResearchSpanName[]) {
      expect(() =>
        tracer.span({
          runId: 'run-1',
          span,
          input: 'abstract text',
          output: 'verdict',
          model: 'm',
          latencyMs: 12,
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
      ).not.toThrow();
    }

    await expect(tracer.onApplicationShutdown()).resolves.toBeUndefined();
  });

  it('emits a span even when run() was never called (no parent context)', () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    const tracer = new ResearchTracer(silentLog);
    expect(() => tracer.span({ runId: 'orphan', span: 'gate', input: 'i', output: 'o' })).not.toThrow();
  });
});
