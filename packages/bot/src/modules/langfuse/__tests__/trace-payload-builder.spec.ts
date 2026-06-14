import { TracePayloadBuilder } from '../trace-payload-builder';

describe('TracePayloadBuilder', () => {
  const builder = new TracePayloadBuilder();

  const spec = (overrides: Partial<Parameters<TracePayloadBuilder['build']>[0]> = {}) => ({
    traceId: 'turn-1',
    span: 'classify' as const,
    input: 'hello',
    output: 'safe',
    enabled: true,
    sampled: true,
    parentEventId: 'parent-1',
    spanEventId: 'span-1',
    timestamp: '2026-06-14T00:00:00.000Z',
    ...overrides,
  });

  // The child observation always lives at batch[1]; the parent trace upsert at batch[0].
  const childOf = (env: ReturnType<TracePayloadBuilder['build']>): any => env!.batch[1];

  describe('build', () => {
    it('returns a parent trace upsert plus a child span observation nested under it', () => {
      const env = builder.build(spec());
      expect(env).not.toBeNull();
      expect(env!.batch).toHaveLength(2);

      const [parent, child] = env!.batch;
      expect(parent.type).toBe('trace-create');
      expect(parent.id).toBe('parent-1');
      expect(parent.body.id).toBe('turn-1');

      expect(child.type).toBe('span-create');
      expect(child.id).toBe('span-1');
      expect(child.body.id).toBe('turn-1-classify');
      // Nesting: the span references the parent trace id.
      expect(child.body.traceId).toBe('turn-1');
      expect(child.body.name).toBe('classify');
    });

    it('parent upsert is stable across spans of the same turn (id + name only, no content)', () => {
      const classify = builder.build(spec({ span: 'classify' }))!.batch[0];
      const coach = builder.build(spec({ span: 'coach', spanEventId: 'span-2' }))!.batch[0];
      expect(classify.body).toEqual(coach.body);
      expect(classify.body).not.toHaveProperty('input');
      expect(classify.body).not.toHaveProperty('output');
    });

    it('retains full input and output content on the child span (ADR-0024, non-crisis)', () => {
      const longInput = 'a'.repeat(300);
      const longOutput = 'b'.repeat(300);
      const child = childOf(builder.build(spec({ input: longInput, output: longOutput })));
      expect(child.body.input).toBe(longInput);
      expect(child.body.output).toBe(longOutput);
    });

    it('records latencyMs on the child span, defaulting to 0', () => {
      expect(childOf(builder.build(spec())).body.metadata.latencyMs).toBe(0);
      expect(childOf(builder.build(spec({ latencyMs: 42 }))).body.metadata.latencyMs).toBe(42);
    });

    it('records confidence on the child span only when provided', () => {
      expect(childOf(builder.build(spec())).body.metadata).not.toHaveProperty('confidence');
      expect(childOf(builder.build(spec({ confidence: 0.9 }))).body.metadata.confidence).toBe(0.9);
    });

    it('accepts every span name in the enum', () => {
      for (const span of ['classify', 'intent', 'coach', 'retrieval', 'memory'] as const) {
        expect(childOf(builder.build(spec({ span }))).body.name).toBe(span);
      }
    });

    it('returns null when disabled (no content-bearing payload)', () => {
      expect(builder.build(spec({ enabled: false }))).toBeNull();
    });

    it('returns null when the turn is unsampled (no content-bearing payload)', () => {
      expect(builder.build(spec({ sampled: false }))).toBeNull();
    });

    it('returns null for crisis turns (ADR-0024 content-drop)', () => {
      expect(builder.build(spec({ isCrisis: true }))).toBeNull();
    });

    it('does not relabel level to debug (legacy sampling behaviour removed)', () => {
      expect(childOf(builder.build(spec())).body).not.toHaveProperty('level');
    });

    it('emits the coach span as a generation-create with model id and token usage', () => {
      const child = childOf(
        builder.build(
          spec({ span: 'coach', model: 'test-coach', usage: { inputTokens: 12, outputTokens: 34 } }),
        ),
      );
      expect(child.type).toBe('generation-create');
      expect(child.body.model).toBe('test-coach');
      expect(child.body.usage).toEqual({ input: 12, output: 34 });
    });

    it('records model id but no usage when the provider omits token counts (absent, not zero)', () => {
      const child = childOf(builder.build(spec({ span: 'coach', model: 'test-coach' })));
      expect(child.body.model).toBe('test-coach');
      expect(child.body).not.toHaveProperty('usage');
    });

    it('includes only the token fields the provider returned', () => {
      const child = childOf(
        builder.build(spec({ span: 'coach', model: 'test-coach', usage: { outputTokens: 7 } })),
      );
      expect(child.body.usage).toEqual({ output: 7 });
    });

    it('merges extra structured metadata (counts/scores/ids) into the span metadata', () => {
      const child = childOf(
        builder.build(
          spec({ span: 'retrieval', input: '', output: '', metadata: { count: 2, ids: ['a', 'b'], scores: [0.9, 0.8] } }),
        ),
      );
      expect(child.body.metadata.count).toBe(2);
      expect(child.body.metadata.ids).toEqual(['a', 'b']);
      expect(child.body.metadata.scores).toEqual([0.9, 0.8]);
      // latencyMs still defaulted alongside the extra metadata.
      expect(child.body.metadata.latencyMs).toBe(0);
    });

    it('emits a plain span as span-create with no model/usage', () => {
      const child = childOf(builder.build(spec()));
      expect(child.type).toBe('span-create');
      expect(child.body).not.toHaveProperty('model');
      expect(child.body).not.toHaveProperty('usage');
    });

    // Type is the span's identity, not inferred from incidental payload: the coach span is a generation
    // even on an error turn that carried no model id or usage, so Langfuse never silently demotes it to
    // a plain span and stops costing it.
    it('emits the coach span as a generation-create even with no model or usage', () => {
      const child = childOf(builder.build(spec({ span: 'coach' })));
      expect(child.type).toBe('generation-create');
    });

    it('emits a non-coach span as span-create and never puts model on it (CreateSpanBody has no model)', () => {
      const child = childOf(builder.build(spec({ span: 'memory', model: 'oops' })));
      expect(child.type).toBe('span-create');
      expect(child.body).not.toHaveProperty('model');
    });

    // Native start/end so Langfuse computes the observation's own latency in the UI.
    it('records startTime and endTime so latency is derivable (endTime - startTime = latencyMs)', () => {
      const child = childOf(builder.build(spec({ latencyMs: 250 })));
      expect(child.body.endTime).toBe('2026-06-14T00:00:00.000Z');
      expect(child.body.startTime).toBe('2026-06-13T23:59:59.750Z');
    });
  });

  describe('shouldSample', () => {
    it('always samples at rate 1', () => {
      expect(builder.shouldSample('any-turn', 1)).toBe(true);
    });

    it('never samples at rate 0', () => {
      expect(builder.shouldSample('any-turn', 0)).toBe(false);
    });

    it('is deterministic per turn (same traceId + rate -> same decision)', () => {
      expect(builder.shouldSample('turn-x', 0.5)).toBe(builder.shouldSample('turn-x', 0.5));
    });
  });
});
