import { CoachHandler, type DmTurnContext } from '../coach-handler';
import { CoachService } from '../coach.service';
import { SessionBufferService } from '../../session-buffer/session-buffer.service';
import { LangfuseTracer } from '../../langfuse/langfuse-tracer.service';
import { MemoryStoreService } from '../../memory/memory-store.service';
import { HabitEngagementService } from '../../habit-engagement/habit-engagement.service';

// buildCoachPrompt and rankByRecency are real (pure) — the handler's job is to gather + order, and
// these prove the wiring reaches the model with recency-ordered read-back.

describe('CoachHandler', () => {
  let handler: CoachHandler;
  let coach: { generate: jest.Mock };
  let sessionBuffer: { append: jest.Mock };
  let langfuseTracer: { trace: jest.Mock };
  let memoryStore: { search: jest.Mock; deriveAndStore: jest.Mock };
  let habitEngagement: { record: jest.Mock };

  const baseCtx = (over: Partial<DmTurnContext> = {}): DmTurnContext => ({
    message: { content: 'i keep tilting in ranked', reply: jest.fn().mockResolvedValue({}) } as any,
    userId: '123',
    batch: 'i keep tilting in ranked',
    session: null,
    strategies: [],
    inAftermath: false,
    timezone: 'UTC',
    traceId: 'trace-1',
    ...over,
  });

  beforeEach(() => {
    coach = { generate: jest.fn().mockResolvedValue('That sounds rough. Hang in there.') };
    sessionBuffer = { append: jest.fn().mockResolvedValue(undefined) };
    langfuseTracer = { trace: jest.fn() };
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
    );
  });

  it('generates a coach reply and sends it', async () => {
    const ctx = baseCtx();

    await handler.handle(ctx);

    expect(coach.generate).toHaveBeenCalledWith(
      expect.stringContaining('compassionate DM companion'),
      expect.stringContaining('i keep tilting in ranked'),
    );
    expect(ctx.message.reply).toHaveBeenCalledWith('That sounds rough. Hang in there.');
  });

  it('orders recalled memories newest-first before building the prompt', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    memoryStore.search.mockResolvedValue([
      { id: 'old', content: 'STALE FACT', similarity: 0.8, updatedAt: Date.now() - 90 * DAY },
      { id: 'new', content: 'FRESH FACT', similarity: 0.8, updatedAt: Date.now() - 1 * DAY },
    ]);

    await handler.handle(baseCtx());

    const prompt = coach.generate.mock.calls[0][1];
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

  it('sends a fallback and skips persistence when the coach returns empty', async () => {
    coach.generate.mockResolvedValue('');
    const ctx = baseCtx();

    await handler.handle(ctx);

    expect(ctx.message.reply).toHaveBeenCalledWith(
      "I'm not sure how to respond to that right now. Want to try again?",
    );
    expect(sessionBuffer.append).not.toHaveBeenCalled();
    expect(memoryStore.deriveAndStore).not.toHaveBeenCalled();
  });
});
