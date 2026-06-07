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
  });

  it('does not trace when disabled', () => {
    tracer.trace('test-1', 'classify', 'input', 'safe');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('skips crisis traces', () => {
    (tracer as any).enabled = true;
    tracer.trace('test-1', 'classify', 'input', 'crisis', { isCrisis: true });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('skips crisis scores', () => {
    (tracer as any).enabled = true;
    tracer.score('test-1', 'safety', 0.5, true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // Non-crisis traces retain full coaching content for eval/quality data (ADR-0024):
  // no truncation or redaction. Crisis content is dropped entirely (covered above).
  it('retains full input content for non-crisis traces', () => {
    process.env.LANGFUSE_HOST = 'http://localhost:3000';
    process.env.LANGFUSE_PUBLIC_KEY = 'test-public';
    process.env.LANGFUSE_SECRET_KEY = 'test-secret';
    tracer = new LangfuseTracer();

    const longInput = 'a'.repeat(300);
    tracer.trace('test-1', 'classify', longInput, 'safe');
    expect(global.fetch).toHaveBeenCalled();
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1]!.body);
    expect(body.input).toBe(longInput);
    expect(body.input).not.toContain('[truncated]');
  });

  it('retains full output content for non-crisis traces', () => {
    process.env.LANGFUSE_HOST = 'http://localhost:3000';
    process.env.LANGFUSE_PUBLIC_KEY = 'test-public';
    process.env.LANGFUSE_SECRET_KEY = 'test-secret';
    tracer = new LangfuseTracer();

    const longOutput = 'b'.repeat(300);
    tracer.trace('test-1', 'coach', 'short', longOutput);
    expect(global.fetch).toHaveBeenCalled();
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1]!.body);
    expect(body.output).toBe(longOutput);
    expect(body.output).not.toContain('[truncated]');
  });
});
