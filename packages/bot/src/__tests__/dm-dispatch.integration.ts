// pg-boss is ESM and is transitively imported via TiltService (a CoachingService
// dependency). It is only used for cron scheduling, which this test never invokes —
// mock it so jest can parse the import while Postgres + Redis stay real.
jest.mock('pg-boss', () => ({
  PgBoss: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    createQueue: jest.fn().mockResolvedValue(undefined),
    schedule: jest.fn().mockResolvedValue(undefined),
    work: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { startInfra, randomDiscordId } from '../integration-harness';
import type { SessionBufferService } from '../modules/session-buffer/session-buffer.service';
import type { EchoController } from '../modules/echo/echo.controller';

// A dispatched DM must flow through the registered listener into the real coaching
// pipeline and persist its side effects (Coaching Session in Postgres, conversation
// turns in Redis). Only the LLM/billing collaborators are mocked; the session,
// buffer, burst coalescer, and database are real. This is the integration counterpart
// to the listener-registration unit test (which proves necord discovers the handler).
describe('DM dispatch integration', () => {
  let infra: Awaited<ReturnType<typeof startInfra>>;
  let echo: EchoController;
  let sessionBuffer: SessionBufferService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;

  const reply = jest.fn().mockResolvedValue({});

  const makeDm = (discordId: string, content: string) =>
    ({
      author: { bot: false, id: discordId },
      channel: { isDMBased: () => true },
      content,
      reply,
    }) as any;

  beforeAll(async () => {
    infra = await startInfra();
    process.env.DATABASE_URL = infra.postgresUrl;
    process.env.REDIS_URL = infra.redisUrl;

    // Drop the cached @wabi/shared prisma singleton (built at static-import time against
    // the wrong URL) so the re-import below binds to the test database.
    delete (globalThis as { prisma?: unknown }).prisma;
    jest.resetModules();

    const { CoachingSessionService } = await import('../modules/session-buffer/coaching-session.service');
    const { SessionBufferService } = await import('../modules/session-buffer/session-buffer.service');
    const { BurstCoalescer } = await import('../modules/burst-coalescer/burst-coalescer.service');
    const { CoachingService } = await import('../modules/coaching/coaching.service');
    const { EchoController } = await import('../modules/echo/echo.controller');
    const { UserService } = await import('../modules/user/user.service');
    const shared = await import('@wabi/shared');
    prisma = shared.prisma;

    const coachingSession = new CoachingSessionService();
    sessionBuffer = new SessionBufferService(infra.redisUrl);
    await sessionBuffer.init();

    // Mocked collaborators — no live LLM, no billing I/O.
    const classifier = { classify: jest.fn().mockResolvedValue('safe') } as any;
    const coach = { generate: jest.fn().mockResolvedValue('Take a breath — one round at a time.') } as any;
    const strategyRetrieval = { search: jest.fn().mockResolvedValue([]) } as any;
    const burstCoalescer = new BurstCoalescer();
    const langfuseTracer = { trace: jest.fn() } as any;
    const accessResolver = { resolve: jest.fn().mockResolvedValue({ hasActiveAccess: true }) } as any;
    const memoryStore = {
      deriveAndStore: jest.fn().mockResolvedValue(undefined),
      search: jest.fn().mockResolvedValue([]),
    } as any;
    const crisisAftermath = {
      isQuarantined: jest.fn().mockResolvedValue(false),
      onEscalation: jest.fn().mockResolvedValue(undefined),
    } as any;
    const escalation = { escalate: jest.fn().mockResolvedValue(undefined) } as any;
    // Coaching now logs the Engagement (streak + XP) through the single writer (ADR-0027).
    const habitEngagement = {
      record: jest.fn().mockResolvedValue({ streak: 1, message: '', xpAwarded: 10 }),
    } as any;
    // The tilt offer lifecycle is consolidated into these two methods (commit 367b56c4):
    // no pending offer to answer, and no detection-driven offer for this safe turn.
    const tilt = {
      respondToPendingOffer: jest.fn().mockResolvedValue({ kind: 'none' }),
      maybeOffer: jest.fn().mockReturnValue(null),
    } as any;

    const coaching = new CoachingService(
      classifier,
      coach,
      sessionBuffer,
      coachingSession,
      strategyRetrieval,
      burstCoalescer,
      langfuseTracer,
      accessResolver,
      memoryStore,
      crisisAftermath,
      escalation,
      habitEngagement,
      tilt,
      new UserService(),
    );

    const crisisScreening = { tripwire: jest.fn().mockReturnValue(false) } as any;
    echo = new EchoController(crisisScreening, escalation, coaching);
  }, 60000);

  afterAll(async () => {
    await sessionBuffer?.disconnect();
    await prisma?.$disconnect();
    await infra.stop();
  }, 30000);

  it('persists a Coaching Session and conversation turns through the listener', async () => {
    const discordId = randomDiscordId();
    await prisma.user.create({
      data: { discordId, consentAcceptedAt: new Date() },
    });

    // Dispatch through the registered listener handler (not the pipeline directly).
    // The burst coalescer debounces ~3s before the turn resolves.
    await echo.handleMessage([makeDm(discordId, 'I keep losing ranked and tilting hard')]);

    // Coaching Session row was opened in Postgres.
    const session = await prisma.coachingSession.findUnique({ where: { discordId } });
    expect(session).not.toBeNull();

    // Conversation turns were buffered in Redis (user message + assistant reply).
    const ctx = await sessionBuffer.getContext(discordId);
    expect(ctx?.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(ctx?.turns[0].content).toContain('tilting');

    // The coach reply was sent back to the user.
    expect(reply).toHaveBeenCalledWith('Take a breath — one round at a time.');
  }, 30000);

  it('ignores bot-authored and non-DM messages (no session created)', async () => {
    const botId = randomDiscordId();
    const guildId = randomDiscordId();

    // Bot-authored DM — ignored.
    await echo.handleMessage([{
      author: { bot: true, id: botId },
      channel: { isDMBased: () => true },
      content: 'beep boop',
      reply,
    }] as any);
    // Non-DM (guild channel) message — ignored.
    await echo.handleMessage([{
      author: { bot: false, id: guildId },
      channel: { isDMBased: () => false },
      content: 'hello channel',
      reply,
    }] as any);

    expect(await prisma.coachingSession.findUnique({ where: { discordId: botId } })).toBeNull();
    expect(await prisma.coachingSession.findUnique({ where: { discordId: guildId } })).toBeNull();
  }, 30000);
});
