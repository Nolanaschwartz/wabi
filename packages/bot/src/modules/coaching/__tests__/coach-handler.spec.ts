import { CoachHandler, type DmTurnContext } from '../coach-handler';
import { CoachService } from '../coach.service';
import { SessionBufferService } from '../../session-buffer/session-buffer.service';
import { LangfuseTracer } from '../../langfuse/langfuse-tracer.service';
import { OtelTracingService } from '../../langfuse/otel-tracing.service';
import { MemoryStoreService } from '../../memory/memory-store.service';
import { HabitEngagementService } from '../../habit-engagement/habit-engagement.service';

// A sentinel for the isolated Langfuse tracer; the handler must hand THIS into the coach generation's
// telemetry so the AI-SDK auto-generation routes to the isolated provider (never Sentry's global one).
const ISOLATED_TRACER = { __isolated: true } as any;

// buildCoachPrompt and rankByRecency are real (pure) — the handler's job is to gather + order, and
// these prove the wiring reaches the model with recency-ordered read-back.

describe('CoachHandler', () => {
  let handler: CoachHandler;
  let coach: { generateDetailed: jest.Mock };
  let sessionBuffer: { append: jest.Mock };
  let langfuseTracer: { span: jest.Mock; score: jest.Mock; traceObservation: jest.Mock; latchCrisis: jest.Mock };
  let otelTracing: { tracer: unknown; score: jest.Mock };
  let memoryStore: { search: jest.Mock; deriveAndStore: jest.Mock };
  let habitEngagement: { record: jest.Mock };

  const baseCtx = (over: Partial<DmTurnContext> = {}): DmTurnContext => ({
    message: { content: 'i keep tilting in ranked', reply: jest.fn().mockResolvedValue({}) } as any,
    userId: '123',
    batch: 'i keep tilting in ranked',
    screenedBatch: { text: 'i keep tilting in ranked' } as any,
    session: null,
    strategies: [],
    memories: [],
    memoryLatencyMs: 0,
    inAftermath: false,
    timezone: 'UTC',
    traceId: 'trace-1',
    ...over,
  });

  beforeEach(() => {
    coach = {
      generateDetailed: jest.fn().mockResolvedValue({
        text: 'That sounds rough. Hang in there.',
        model: 'test-coach',
        usage: { inputTokens: 12, outputTokens: 34 },
      }),
    };
    sessionBuffer = { append: jest.fn().mockResolvedValue(undefined) };
    langfuseTracer = { span: jest.fn(), score: jest.fn(), traceObservation: jest.fn(), latchCrisis: jest.fn() };
    otelTracing = { tracer: ISOLATED_TRACER, score: jest.fn() };
    memoryStore = {
      search: jest.fn().mockResolvedValue([]),
      deriveAndStore: jest.fn().mockResolvedValue(undefined),
    };
    habitEngagement = { record: jest.fn().mockResolvedValue({ streak: 1, message: '', xpAwarded: 10 }) };
    handler = new CoachHandler(
      coach as unknown as CoachService,
      sessionBuffer as unknown as SessionBufferService,
      langfuseTracer as unknown as LangfuseTracer,
      memoryStore as unknown as MemoryStoreService,
      habitEngagement as unknown as HabitEngagementService,
      otelTracing as unknown as OtelTracingService,
    );
  });

  it('generates a coach reply and sends it', async () => {
    const ctx = baseCtx();

    await handler.handle(ctx);

    expect(coach.generateDetailed).toHaveBeenCalledWith(
      expect.stringContaining('compassionate DM companion'),
      expect.stringContaining('i keep tilting in ranked'),
      expect.objectContaining({ isEnabled: true, functionId: 'coach' }),
    );
    expect(ctx.message.reply).toHaveBeenCalledWith('That sounds rough. Hang in there.');
  });

  it('threads the signup Personalization slugs into the built coach prompt', async () => {
    // The slugs ride the dispatch context like timezone; the handler hands them to buildCoachPrompt,
    // which expands them to phrases/labels. Proves the wiring reaches the model.
    await handler.handle(baseCtx({ personalization: { areas: ['tilt'], interests: ['fps'] } }));

    const prompt = coach.generateDetailed.mock.calls[0][1];
    expect(prompt).toContain('What this person told us at signup:');
    expect(prompt).toContain('managing tilt and frustration while gaming');
    expect(prompt).toContain('FPS');
  });

  it('instruments the coach generation with telemetry routed to the isolated tracer', async () => {
    // Model/usage/latency + prompt+reply are captured by the AI SDK's auto-generation (recordInputs/
    // Outputs), routed to the isolated Langfuse tracer — replacing the old manual coach span.
    await handler.handle(baseCtx());

    expect(coach.generateDetailed).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        isEnabled: true,
        tracer: ISOLATED_TRACER,
        recordInputs: true,
        recordOutputs: true,
        functionId: 'coach',
      }),
    );
  });

  it('never emits the coach content through a manual tracer span (it is the AI-SDK generation)', async () => {
    await handler.handle(baseCtx());

    const manualCoachSpan = langfuseTracer.traceObservation.mock.calls
      .map((c) => c[0] as any)
      .find((p) => p.name === 'coach');
    expect(manualCoachSpan).toBeUndefined();
  });

  it('emits a memory span with recall counts/similarities/ids and no memory text', async () => {
    await handler.handle(baseCtx({ memories: [
      { id: 'm1', content: 'SECRET FACT ONE', similarity: 0.9, updatedAt: 1 },
      { id: 'm2', content: 'SECRET FACT TWO', similarity: 0.8, updatedAt: 2 },
    ] }));

    const memory = langfuseTracer.traceObservation.mock.calls.map((c) => c[0] as any).find((p) => p.name === 'memory');
    expect(memory).toBeDefined();
    expect(memory.metadata.count).toBe(2);
    expect(memory.metadata.ids).toEqual(['m1', 'm2']);
    expect(memory.metadata.similarities).toEqual([0.9, 0.8]);
    expect(memory.input).toBe('');
    expect(memory.output).toBe('');
    // No verbatim memory text crosses into the span.
    expect(JSON.stringify(memory)).not.toContain('SECRET FACT');
  });

  it('includes the query and recalled memory text on the memory span in local full fidelity', async () => {
    (langfuseTracer as any).localFullFidelity = true;

    await handler.handle(baseCtx({ memories: [
      { id: 'm1', content: 'plays Valorant nightly', similarity: 0.9, updatedAt: 1 },
    ] }));

    const memory = langfuseTracer.traceObservation.mock.calls.map((c) => c[0] as any).find((p) => p.name === 'memory');
    expect(memory.input).not.toBe('');
    expect(memory.output).toContain('plays Valorant nightly');
    // Metadata still present alongside the verbatim text.
    expect(memory.metadata.ids).toEqual(['m1']);
  });

  it('replies with a disabled (real) tracer — hot-path isolation', async () => {
    // A real tracer with no Langfuse env is disabled and emits nothing; the reply must proceed.
    const disabledHandler = new CoachHandler(
      coach as unknown as CoachService,
      sessionBuffer as unknown as SessionBufferService,
      new LangfuseTracer(),
      memoryStore as unknown as MemoryStoreService,
      habitEngagement as unknown as HabitEngagementService,
      otelTracing as unknown as OtelTracingService,
    );
    const ctx = baseCtx();

    await expect(disabledHandler.handle(ctx)).resolves.toBeUndefined();
    expect(ctx.message.reply).toHaveBeenCalledWith('That sounds rough. Hang in there.');
  });

  it('orders recalled memories newest-first before building the prompt', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    await handler.handle(baseCtx({ memories: [
      { id: 'old', content: 'STALE FACT', similarity: 0.8, updatedAt: Date.now() - 90 * DAY },
      { id: 'new', content: 'FRESH FACT', similarity: 0.8, updatedAt: Date.now() - 1 * DAY },
    ] }));

    const prompt = coach.generateDetailed.mock.calls[0][1];
    expect(prompt.indexOf('FRESH FACT')).toBeLessThan(prompt.indexOf('STALE FACT'));
  });

  it('appends both turns to the session buffer using verbatim content', async () => {
    const ctx = baseCtx();

    await handler.handle(ctx);

    expect(sessionBuffer.append).toHaveBeenCalledWith('123', 'user', 'i keep tilting in ranked');
    expect(sessionBuffer.append).toHaveBeenCalledWith('123', 'assistant', 'That sounds rough. Hang in there.');
  });

  it('records the coaching streak with the passed timezone', async () => {
    await handler.handle(baseCtx({ timezone: 'America/New_York' }));

    expect(habitEngagement.record).toHaveBeenCalledWith('123', 'coaching', 'America/New_York');
  });

  it('fires memory derivation without awaiting it (after the reply is sent)', async () => {
    // deriveAndStore never resolves — the handler must still complete and reply.
    memoryStore.deriveAndStore.mockReturnValue(new Promise<void>(() => {}));
    const ctx = baseCtx();

    await handler.handle(ctx);

    expect(memoryStore.deriveAndStore).toHaveBeenCalledWith('123', expect.stringContaining('i keep tilting in ranked'));
    expect(ctx.message.reply).toHaveBeenCalledWith('That sounds rough. Hang in there.');
  });

  it('records a latency-SLA score and a reply-present score on a successful turn', async () => {
    await handler.handle(baseCtx());

    const scores = otelTracing.score.mock.calls.map((c) => ({ traceId: c[0], name: c[1], value: c[2] }));
    const latency = scores.find((s) => s.name === 'latency_sla');
    const present = scores.find((s) => s.name === 'reply_present');
    expect(latency).toBeDefined();
    expect(latency!.traceId).toBe('trace-1');
    expect(present).toEqual({ name: 'reply_present', value: 1, traceId: 'trace-1' });
  });

  it('records reply_present=0 when the coach returns empty', async () => {
    coach.generateDetailed.mockResolvedValue({ text: '', model: 'test-coach' });

    await handler.handle(baseCtx());

    expect(otelTracing.score).toHaveBeenCalledWith('trace-1', 'reply_present', 0);
  });

  it('still replies when scoring throws (hot-path isolation)', async () => {
    otelTracing.score.mockImplementation(() => {
      throw new Error('score down');
    });
    const ctx = baseCtx();

    await expect(handler.handle(ctx)).resolves.toBeUndefined();
    expect(ctx.message.reply).toHaveBeenCalledWith('That sounds rough. Hang in there.');
  });

  it('still instruments the coach generation when the coach returns empty (cost visibility on failures)', async () => {
    // The empty/refused generation still burned tokens — the AI-SDK auto-generation runs regardless,
    // so the failure turn is still captured for cost monitoring. Telemetry is passed on every coach call.
    coach.generateDetailed.mockResolvedValue({ text: '', model: 'test-coach', usage: { inputTokens: 9, outputTokens: 0 } });

    await handler.handle(baseCtx());

    expect(coach.generateDetailed).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ isEnabled: true, tracer: ISOLATED_TRACER, functionId: 'coach' }),
    );
  });

  it('replies given no recalled memories (upstream recall degraded to [] — hot-path isolation)', async () => {
    // Recall now runs upstream in CoachingService and fails open to []; the handler must coach fine on
    // an empty memories ctx.
    const ctx = baseCtx({ memories: [] });

    await expect(handler.handle(ctx)).resolves.toBeUndefined();
    expect(ctx.message.reply).toHaveBeenCalledWith('That sounds rough. Hang in there.');
  });

  it('sends a fallback and skips persistence when the coach returns empty', async () => {
    coach.generateDetailed.mockResolvedValue({ text: '', model: 'test-coach' });
    const ctx = baseCtx();

    await handler.handle(ctx);

    expect(ctx.message.reply).toHaveBeenCalledWith(
      "I'm not sure how to respond to that right now. Want to try again?",
    );
    expect(sessionBuffer.append).not.toHaveBeenCalled();
    expect(memoryStore.deriveAndStore).not.toHaveBeenCalled();
  });
});
