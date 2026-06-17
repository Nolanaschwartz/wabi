/**
 * ResearchTracer — the research worker's Langfuse span vocabulary (ADR-0037, ADR-0024).
 *
 * Wraps the content-AGNOSTIC `@wabi/shared/langfuse` kernel (mocked here) and owns the run/paper
 * span shape: a RUN is the parent trace; each paper's `gate`/`extract`/`dedup` are child spans.
 * Unlike the bot's tracer this carries NO crisis latch and NO redaction — the research worker
 * handles no user content and has no crisis concept (a "crisis-like" input must NOT suppress spans).
 */

// Mock the kernel so we assert the emitted batch tree without any network. The mock exposes the
// post/flush spies and a toggleable `enabled` so a spec can simulate the no-env (disabled) case.
const post = jest.fn();
const flush = jest.fn().mockResolvedValue(undefined);
const shouldSample = jest.fn().mockReturnValue(true);
let enabled = true;
jest.mock('@wabi/shared/langfuse', () => ({
  LangfuseIngest: jest.fn().mockImplementation(() => ({
    get enabled() {
      return enabled;
    },
    shouldSample,
    post,
    flush,
  })),
}));

import { ResearchTracer } from '../research-tracer';

beforeEach(() => {
  jest.clearAllMocks();
  enabled = true;
  shouldSample.mockReturnValue(true);
});

describe('ResearchTracer', () => {
  it('emits a parent run trace + the three child spans (gate/extract/dedup) for one paper', () => {
    const tracer = new ResearchTracer();
    const runId = 'run-1';

    tracer.span({ runId, span: 'gate', input: 'abstract', output: 'yes', model: 'm', latencyMs: 5, usage: { inputTokens: 3, outputTokens: 1 } });
    tracer.span({ runId, span: 'extract', input: 'body', output: '{"title":"t"}', model: 'm', latencyMs: 9 });
    tracer.span({ runId, span: 'dedup', input: 'A vs B', output: 'different', model: 'm', latencyMs: 4 });

    expect(post).toHaveBeenCalledTimes(3);

    // Each span posts a 2-event batch: a content-free parent trace-create (the RUN) + the child span.
    for (const call of post.mock.calls) {
      const batch = call[1].batch as Array<{ type: string; body: { id: string; name?: string; traceId?: string } }>;
      const parent = batch.find((e) => e.type === 'trace-create')!;
      expect(parent.body.id).toBe(runId);
      expect(parent.body.name).toBe('run'); // parent trace is named "run", not "turn"
    }

    const spans = post.mock.calls.map((c) => {
      const batch = c[1].batch as Array<{ type: string; body: { name?: string; traceId?: string } }>;
      return batch.find((e) => e.type !== 'trace-create')!.body;
    });
    expect(spans.map((s) => s.name)).toEqual(['gate', 'extract', 'dedup']);
    // every child span hangs under the run trace
    expect(spans.every((s) => s.traceId === runId)).toBe(true);
  });

  it('records leaf data (input/output/model/usage/latency) on a span', () => {
    const tracer = new ResearchTracer();
    tracer.span({ runId: 'r', span: 'extract', input: 'in', output: 'out', model: 'qwopus', latencyMs: 12, usage: { inputTokens: 7, outputTokens: 4 } });

    const batch = post.mock.calls[0][1].batch as Array<{ type: string; body: Record<string, unknown> }>;
    const span = batch.find((e) => e.type !== 'trace-create')!.body;
    expect(span.input).toBe('in');
    expect(span.output).toBe('out');
    expect(span.model).toBe('qwopus');
    expect(span.usage).toEqual({ input: 7, output: 4 });
    // a startTime/endTime pair so Langfuse computes the span's own latency
    expect(typeof span.startTime).toBe('string');
    expect(typeof span.endTime).toBe('string');
  });

  it('does NOT apply a crisis latch — a "crisis-like" input still emits its spans (no such concept here)', () => {
    const tracer = new ResearchTracer();
    const runId = 'run-crisis';
    // There is deliberately no isCrisis param; even content that would trip the bot is just text here.
    tracer.span({ runId, span: 'gate', input: 'I want to die — is this a coping technique?', output: 'no' });
    tracer.span({ runId, span: 'extract', input: 'still here', output: 'null' });

    // Both spans were posted — nothing was suppressed, because the research tracer has no latch.
    expect(post).toHaveBeenCalledTimes(2);
    const names = post.mock.calls.map((c) => {
      const batch = c[1].batch as Array<{ type: string; body: { name?: string } }>;
      return batch.find((e) => e.type !== 'trace-create')!.body.name;
    });
    expect(names).toEqual(['gate', 'extract']);
  });

  it('is a clean no-op when tracing is disabled (no Langfuse env) — nothing is posted', () => {
    enabled = false;
    const tracer = new ResearchTracer();
    tracer.run({ runId: 'r' });
    tracer.span({ runId: 'r', span: 'gate', input: 'a', output: 'b' });
    tracer.span({ runId: 'r', span: 'extract', input: 'a', output: 'b' });
    expect(post).not.toHaveBeenCalled();
  });

  it('skips the post when the run is not sampled (whole run dropped as a unit)', () => {
    shouldSample.mockReturnValue(false);
    const tracer = new ResearchTracer();
    tracer.span({ runId: 'r', span: 'gate', input: 'a', output: 'b' });
    expect(post).not.toHaveBeenCalled();
  });

  it('run() upserts a standalone parent trace so a paper-less run still appears', () => {
    const tracer = new ResearchTracer();
    tracer.run({ runId: 'run-empty' });
    expect(post).toHaveBeenCalledTimes(1);
    const batch = post.mock.calls[0][1].batch as Array<{ type: string; body: { id: string; name?: string } }>;
    expect(batch).toHaveLength(1);
    expect(batch[0].type).toBe('trace-create');
    expect(batch[0].body).toMatchObject({ id: 'run-empty', name: 'run' });
  });

  it('never throws out of span(): a kernel post error is swallowed', () => {
    post.mockImplementation(() => {
      throw new Error('boom');
    });
    const tracer = new ResearchTracer();
    expect(() => tracer.span({ runId: 'r', span: 'gate', input: 'a', output: 'b' })).not.toThrow();
  });

  it('flushes the kernel on application shutdown', async () => {
    const tracer = new ResearchTracer();
    await tracer.onApplicationShutdown();
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
