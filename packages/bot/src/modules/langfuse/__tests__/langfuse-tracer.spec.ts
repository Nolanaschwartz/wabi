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
});
