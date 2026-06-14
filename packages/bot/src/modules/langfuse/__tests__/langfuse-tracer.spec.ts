import { LangfuseTracer } from '../langfuse-tracer.service';

describe('LangfuseTracer', () => {
  let tracer: LangfuseTracer;

  beforeEach(() => {
    tracer = new LangfuseTracer();
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    delete process.env.LANGFUSE_SAMPLE_RATE;
    delete process.env.LANGFUSE_FLUSH_TIMEOUT_MS;
    delete process.env.LANGFUSE_HOST;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
  });

  it('does not trace when disabled', () => {
    tracer = new LangfuseTracer();
    tracer.span({ traceId: 'test-1', span: 'classify', input: 'input', output: 'safe' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // Load-order regression: the tracer may be constructed BEFORE ConfigModule populates process.env
  // (exactly what disabled Langfuse in dev). enablement must be evaluated per-call, not frozen in
  // the constructor — otherwise an early construction disables tracing forever.
  it('traces when env appears AFTER construction', () => {
    const lateTracer = new LangfuseTracer();

    process.env.LANGFUSE_HOST = 'http://localhost:3000';
    process.env.LANGFUSE_PUBLIC_KEY = 'test-public';
    process.env.LANGFUSE_SECRET_KEY = 'test-secret';

    lateTracer.span({ traceId: 'test-1', span: 'classify', input: 'input', output: 'safe' });
    expect(global.fetch).toHaveBeenCalled();
  });

  it('skips crisis spans (no content-bearing ingestion)', () => {
    enabledTracer().span({ traceId: 'test-1', span: 'classify', input: 'input', output: 'crisis', isCrisis: true });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('skips crisis scores', () => {
    enabledTracer().score('test-1', 'safety', 0.5, true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('posts a score-create event attached to the trace id', () => {
    enabledTracer().score('test-1', 'latency_sla', 1);
    const event = batch().find((e: any) => e.type === 'score-create');
    expect(event.body.traceId).toBe('test-1');
    expect(event.body.name).toBe('latency_sla');
    expect(event.body.value).toBe(1);
  });

  // Scores carry the content-free parent trace upsert so a score is never orphaned on a turn whose
  // (heavy, content-bearing) spans were sampled out.
  it('emits the content-free parent trace alongside the score', () => {
    enabledTracer().score('test-1', 'latency_sla', 1);
    const parent = batch().find((e: any) => e.type === 'trace-create');
    expect(parent.body.id).toBe('test-1');
    expect(parent.body).not.toHaveProperty('input');
    expect(parent.body).not.toHaveProperty('output');
  });

  // Eval scores are full-fidelity (NOT span-sampled): aggregate quality/SLA rates need every turn, and
  // a score is content-free so there is no privacy/volume reason to drop it. (Finding #2.)
  it('records scores on every turn even when content spans are unsampled (rate 0)', () => {
    delete process.env.NODE_ENV;
    process.env.LANGFUSE_SAMPLE_RATE = '0';
    enabledTracer().score('test-1', 'latency_sla', 1);
    const event = batch().find((e: any) => e.type === 'score-create');
    expect(event.body.value).toBe(1);
  });

  // Central crisis latch: once ANY span of a turn is flagged crisis, every later span/score for that
  // traceId is suppressed — a new call site that forgets isCrisis cannot leak crisis content. (Finding #3.)
  it('suppresses all later spans and scores of a turn once it is flagged crisis', () => {
    const t = enabledTracer();
    t.span({ traceId: 'c1', span: 'classify', input: 'crisis text', output: 'crisis', isCrisis: true });
    // These later calls do NOT set isCrisis, yet must still be dropped because the turn is latched.
    t.span({ traceId: 'c1', span: 'coach', input: 'verbatim secret', output: 'verbatim secret' });
    t.score('c1', 'reply_present', 1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('still traces a different, non-crisis turn after a crisis turn was latched', () => {
    const t = enabledTracer();
    t.span({ traceId: 'c1', span: 'classify', input: 'x', output: 'crisis', isCrisis: true });
    t.span({ traceId: 'ok-2', span: 'classify', input: 'x', output: 'safe' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  // Shutdown must not hang on a Langfuse that accepts the connection but never responds. (Finding #10.)
  it('flush resolves within the timeout even if an in-flight POST never settles', async () => {
    process.env.LANGFUSE_FLUSH_TIMEOUT_MS = '20';
    (global.fetch as jest.Mock).mockImplementation(() => new Promise<Response>(() => {}));
    const t = enabledTracer();
    t.span({ traceId: 'hang-1', span: 'classify', input: 'i', output: 'safe' });

    await expect(t.onApplicationShutdown()).resolves.toBeUndefined();
    delete process.env.LANGFUSE_FLUSH_TIMEOUT_MS;
  });

  it('awaits in-flight ingestion on application shutdown', async () => {
    let resolveFetch: (v: Response) => void = () => {};
    (global.fetch as jest.Mock).mockImplementation(
      () => new Promise<Response>((res) => { resolveFetch = res; }),
    );
    const t = enabledTracer();
    t.span({ traceId: 'test-1', span: 'classify', input: 'i', output: 'safe' });

    let shutdownDone = false;
    const shutdown = t.onApplicationShutdown().then(() => { shutdownDone = true; });
    // Shutdown should still be pending while the fetch is in flight.
    await Promise.resolve();
    expect(shutdownDone).toBe(false);

    resolveFetch({ ok: true, json: async () => ({}) } as Response);
    await shutdown;
    expect(shutdownDone).toBe(true);
  });

  it('does not throw on shutdown when a flush fails', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('network down'));
    const t = enabledTracer();
    t.span({ traceId: 'test-1', span: 'classify', input: 'i', output: 'safe' });

    await expect(t.onApplicationShutdown()).resolves.toBeUndefined();
  });

  it('shutdown is a no-op when disabled (nothing in flight)', async () => {
    const t = new LangfuseTracer();
    t.span({ traceId: 'test-1', span: 'classify', input: 'i', output: 'safe' });
    await expect(t.onApplicationShutdown()).resolves.toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  const enabledTracer = () => {
    process.env.LANGFUSE_HOST = 'http://localhost:3000';
    process.env.LANGFUSE_PUBLIC_KEY = 'test-public';
    process.env.LANGFUSE_SECRET_KEY = 'test-secret';
    return new LangfuseTracer();
  };

  const lastCall = () => (global.fetch as jest.Mock).mock.calls[0];
  const batch = () => JSON.parse(lastCall()[1]!.body as string).batch;

  it('posts to the Langfuse ingestion endpoint', () => {
    enabledTracer().span({ traceId: 'test-1', span: 'classify', input: 'input', output: 'safe' });
    expect(lastCall()[0]).toBe('http://localhost:3000/api/public/ingestion');
  });

  it('authenticates with HTTP Basic auth (public:secret)', () => {
    enabledTracer().span({ traceId: 'test-1', span: 'classify', input: 'input', output: 'safe' });
    const headers = lastCall()[1]!.headers as Record<string, string>;
    const expected = `Basic ${Buffer.from('test-public:test-secret').toString('base64')}`;
    expect(headers.Authorization).toBe(expected);
  });

  // A turn is one tree: a parent trace-create plus a child observation nested under it via traceId.
  it('emits a parent trace and a child span observation nested under it', () => {
    enabledTracer().span({ traceId: 'test-1', span: 'classify', input: 'input', output: 'safe' });
    const events = batch();
    const parent = events.find((e: any) => e.type === 'trace-create');
    const child = events.find((e: any) => e.type !== 'trace-create');
    expect(parent.body.id).toBe('test-1');
    expect(child.body.traceId).toBe('test-1');
    expect(child.body.name).toBe('classify');
  });

  it('records per-span latency on the child observation', () => {
    enabledTracer().span({ traceId: 'test-1', span: 'coach', input: 'p', output: 'r', latencyMs: 123 });
    const child = batch().find((e: any) => e.type !== 'trace-create');
    expect(child.body.metadata.latencyMs).toBe(123);
  });

  it('records confidence on the intent span', () => {
    enabledTracer().span({ traceId: 'test-1', span: 'intent', input: 'i', output: 'journal', confidence: 0.7 });
    const child = batch().find((e: any) => e.type !== 'trace-create');
    expect(child.body.metadata.confidence).toBe(0.7);
  });

  // In dev we want every non-crisis trace sampled (full visibility); prod stays at 10%. The rate is
  // read per-call from env / NODE_ENV so it tracks the running environment, not import time.
  it('sends every non-crisis turn in dev (NODE_ENV not production)', () => {
    delete process.env.NODE_ENV;
    delete process.env.LANGFUSE_SAMPLE_RATE;
    enabledTracer().span({ traceId: 'test-1', span: 'classify', input: 'input', output: 'safe' });
    expect(global.fetch).toHaveBeenCalled();
  });

  // Regression-replacing test: at rate 0 the turn is unsampled, so NO content-bearing payload is
  // sent at all (parent + spans dropped as a unit).
  it('sends nothing when the sample rate is 0', () => {
    delete process.env.NODE_ENV;
    process.env.LANGFUSE_SAMPLE_RATE = '0';
    enabledTracer().span({ traceId: 'test-1', span: 'classify', input: 'input', output: 'safe' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // Non-crisis spans retain full coaching content for eval/quality data (ADR-0024): no truncation
  // or redaction. Crisis content is dropped entirely (covered above).
  it('retains full input content on the child span for non-crisis turns', () => {
    const longInput = 'a'.repeat(300);
    enabledTracer().span({ traceId: 'test-1', span: 'classify', input: longInput, output: 'safe' });
    const child = batch().find((e: any) => e.type !== 'trace-create');
    expect(child.body.input).toBe(longInput);
    expect(child.body.input).not.toContain('[truncated]');
  });

  it('retains full output content on the child span for non-crisis turns', () => {
    const longOutput = 'b'.repeat(300);
    enabledTracer().span({ traceId: 'test-1', span: 'coach', input: 'short', output: longOutput });
    const child = batch().find((e: any) => e.type !== 'trace-create');
    expect(child.body.output).toBe(longOutput);
    expect(child.body.output).not.toContain('[truncated]');
  });
});
