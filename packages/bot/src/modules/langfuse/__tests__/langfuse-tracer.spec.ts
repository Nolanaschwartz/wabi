import { LangfuseTracer } from '../langfuse-tracer.service';

describe('LangfuseTracer', () => {
  let tracer: LangfuseTracer;

  beforeEach(() => {
    tracer = new LangfuseTracer();
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
    } as Response);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    delete process.env.LANGFUSE_SAMPLE_RATE;
    delete process.env.LANGFUSE_HOST;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
  });

  it('does not trace when disabled', () => {
    delete process.env.LANGFUSE_HOST;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    tracer = new LangfuseTracer();
    tracer.trace('test-1', 'classify', 'input', 'safe');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // Load-order regression: the tracer may be constructed BEFORE ConfigModule populates process.env
  // (exactly what disabled Langfuse in dev). enablement must be evaluated per-call, not frozen in
  // the constructor — otherwise an early construction disables tracing forever.
  it('traces when env appears AFTER construction', () => {
    delete process.env.LANGFUSE_HOST;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    const lateTracer = new LangfuseTracer();

    process.env.LANGFUSE_HOST = 'http://localhost:3000';
    process.env.LANGFUSE_PUBLIC_KEY = 'test-public';
    process.env.LANGFUSE_SECRET_KEY = 'test-secret';

    lateTracer.trace('test-1', 'classify', 'input', 'safe');
    expect(global.fetch).toHaveBeenCalled();
  });

  it('skips crisis traces', () => {
    enabledTracer().trace('test-1', 'classify', 'input', 'crisis', { isCrisis: true });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('skips crisis scores', () => {
    enabledTracer().score('test-1', 'safety', 0.5, true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  const enabledTracer = () => {
    process.env.LANGFUSE_HOST = 'http://localhost:3000';
    process.env.LANGFUSE_PUBLIC_KEY = 'test-public';
    process.env.LANGFUSE_SECRET_KEY = 'test-secret';
    return new LangfuseTracer();
  };

  const lastCall = () => (global.fetch as jest.Mock).mock.calls[0];

  // Langfuse ingestion contract: POST /api/public/ingestion, HTTP Basic auth (public:secret),
  // body { batch: [{ id, type, timestamp, body }] }. The previous code posted a flat object to
  // /api/traces with an x-api-key header — a 404 that silently dropped every trace.
  it('posts to the Langfuse ingestion endpoint', () => {
    enabledTracer().trace('test-1', 'classify', 'input', 'safe');
    expect(lastCall()[0]).toBe('http://localhost:3000/api/public/ingestion');
  });

  it('authenticates with HTTP Basic auth (public:secret)', () => {
    enabledTracer().trace('test-1', 'classify', 'input', 'safe');
    const headers = lastCall()[1]!.headers as Record<string, string>;
    const expected = `Basic ${Buffer.from('test-public:test-secret').toString('base64')}`;
    expect(headers.Authorization).toBe(expected);
  });

  it('wraps the trace in a batch envelope with a trace-create event', () => {
    enabledTracer().trace('test-1', 'classify', 'input', 'safe');
    const body = JSON.parse(lastCall()[1]!.body as string);
    expect(Array.isArray(body.batch)).toBe(true);
    const event = body.batch[0];
    expect(event.type).toBe('trace-create');
    expect(typeof event.id).toBe('string');
    expect(typeof event.timestamp).toBe('string');
    expect(event.body.name).toBe('classify');
  });

  // In dev we want every non-crisis trace sampled (full visibility); prod stays at 10%. The rate is
  // read per-call from env / NODE_ENV so it tracks the running environment, not import time.
  it('samples all traces in dev (NODE_ENV not production)', () => {
    delete process.env.NODE_ENV;
    delete process.env.LANGFUSE_SAMPLE_RATE;
    enabledTracer().trace('test-1', 'classify', 'input', 'safe');
    const event = JSON.parse(lastCall()[1]!.body as string).batch[0];
    expect(event.body.metadata.sampled).toBe(true);
  });

  it('honors an explicit LANGFUSE_SAMPLE_RATE override', () => {
    delete process.env.NODE_ENV;
    process.env.LANGFUSE_SAMPLE_RATE = '0';
    enabledTracer().trace('test-1', 'classify', 'input', 'safe');
    const event = JSON.parse(lastCall()[1]!.body as string).batch[0];
    expect(event.body.metadata.sampled).toBe(false);
  });

  // Non-crisis traces retain full coaching content for eval/quality data (ADR-0024):
  // no truncation or redaction. Crisis content is dropped entirely (covered above).
  it('retains full input content for non-crisis traces', () => {
    const longInput = 'a'.repeat(300);
    enabledTracer().trace('test-1', 'classify', longInput, 'safe');
    expect(global.fetch).toHaveBeenCalled();
    const event = JSON.parse(lastCall()[1]!.body as string).batch[0];
    expect(event.body.input).toBe(longInput);
    expect(event.body.input).not.toContain('[truncated]');
  });

  it('retains full output content for non-crisis traces', () => {
    const longOutput = 'b'.repeat(300);
    enabledTracer().trace('test-1', 'coach', 'short', longOutput);
    expect(global.fetch).toHaveBeenCalled();
    const event = JSON.parse(lastCall()[1]!.body as string).batch[0];
    expect(event.body.output).toBe(longOutput);
    expect(event.body.output).not.toContain('[truncated]');
  });
});
