// The ResearchGenerate seam: a per-run wrapper that binds role→cap, runs the shared `generate`, and on
// SUCCESS emits the step's Langfuse span. It does NOT own fail policy — a transport throw propagates so
// the calling step's own catch produces its domain fail-open value. Tracing stays fail-open: a tracer
// error inside the seam never propagates. `generate` is mocked so we drive the seam in isolation.
jest.mock('@wabi/shared/generate', () => ({ generate: jest.fn() }));

import { makeResearchGenerate, type SpanEmitter } from '../research-generate';
import { triageMaxTokens, extractMaxTokens } from '../../config';

const { generate } = require('@wabi/shared/generate') as { generate: jest.Mock };
const result = (over: Partial<{ text: string; usage: object; model: string; latencyMs: number }> = {}) => ({
  text: 'reply', usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 }, model: 'qwopus', latencyMs: 12, ...over,
});

function fakeTracer(): SpanEmitter & { span: jest.Mock } {
  return { span: jest.fn() };
}

beforeEach(() => jest.clearAllMocks());

describe('makeResearchGenerate', () => {
  it('binds the triage output cap for a research-triage role', async () => {
    generate.mockResolvedValue(result());
    const gen = makeResearchGenerate();
    await gen('gate', 'research-triage', { prompt: 'p', temperature: 0 });
    expect(generate.mock.calls[0][0]).toBe('research-triage');
    expect(generate.mock.calls[0][1].maxOutputTokens).toBe(triageMaxTokens());
  });

  it('binds the extract output cap for a research role', async () => {
    generate.mockResolvedValue(result());
    const gen = makeResearchGenerate();
    await gen('extract', 'research', { prompt: 'p' });
    expect(generate.mock.calls[0][0]).toBe('research');
    expect(generate.mock.calls[0][1].maxOutputTokens).toBe(extractMaxTokens());
  });

  it('passes prompt, temperature, and system through to generate', async () => {
    generate.mockResolvedValue(result());
    const gen = makeResearchGenerate();
    await gen('gate', 'research-triage', { prompt: 'the prompt', temperature: 0, system: 'sys' });
    expect(generate.mock.calls[0][1]).toMatchObject({ prompt: 'the prompt', temperature: 0, system: 'sys' });
  });

  it('returns the generate result unchanged', async () => {
    generate.mockResolvedValue(result({ text: 'verdict' }));
    const gen = makeResearchGenerate();
    const r = await gen('dedup', 'research-triage', { prompt: 'p' });
    expect(r.text).toBe('verdict');
    expect(r.usage?.totalTokens).toBe(10);
  });

  it('emits exactly ONE span per successful call, carrying input/output/model/usage/latency', async () => {
    generate.mockResolvedValue(result());
    const tracer = fakeTracer();
    const gen = makeResearchGenerate(tracer, 'run-1');
    await gen('judge', 'research', { prompt: 'the prompt' });
    expect(tracer.span).toHaveBeenCalledTimes(1);
    expect(tracer.span.mock.calls[0][0]).toMatchObject({
      runId: 'run-1',
      span: 'judge',
      input: 'the prompt',
      output: 'reply',
      model: 'qwopus',
      latencyMs: 12,
      usage: { inputTokens: 4, outputTokens: 6 },
    });
  });

  it('emits NO span when tracing is disabled (no tracer/runId) but still runs generate', async () => {
    generate.mockResolvedValue(result());
    const gen = makeResearchGenerate(undefined, undefined);
    const r = await gen('gate', 'research-triage', { prompt: 'p' });
    expect(r.text).toBe('reply');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('propagates a generate (transport) throw so the calling step owns the fail policy', async () => {
    generate.mockRejectedValue(new Error('ECONNREFUSED'));
    const tracer = fakeTracer();
    const gen = makeResearchGenerate(tracer, 'run-1');
    await expect(gen('gate', 'research-triage', { prompt: 'p' })).rejects.toThrow('ECONNREFUSED');
    expect(tracer.span).not.toHaveBeenCalled(); // no span on a failed call
  });

  it('is fail-open on a tracer error — the result still returns and the throw never propagates', async () => {
    generate.mockResolvedValue(result());
    const tracer: SpanEmitter = { span: jest.fn(() => { throw new Error('langfuse down'); }) };
    const gen = makeResearchGenerate(tracer, 'run-1');
    const r = await gen('extract', 'research', { prompt: 'p' });
    expect(r.text).toBe('reply'); // the run got its result despite the tracer fault
  });
});
