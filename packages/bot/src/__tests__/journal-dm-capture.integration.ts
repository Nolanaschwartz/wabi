// pg-boss is ESM and is transitively imported via TiltService (a CoachingService dependency). It is
// only used for cron scheduling, which this test never invokes — mock it so jest can parse the import
// while Postgres + Redis stay real.
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
import type { JournalSessionService } from '../modules/journal/journal-session.service';
import type { CoachingService } from '../modules/coaching/coaching.service';

// The two-turn conversational journal capture, end-to-end against real Postgres + Redis. A bare "i want
// to journal" arms a pending marker (Redis) and writes NO entry; the next DM is consumed and persisted
// as a JournalEntry (Postgres). A crisis on the capture turn clears the marker and saves nothing — the
// crisis text never reaches the journal writer (ADR-0021/0028).
describe('Journal DM two-turn capture integration', () => {
  let infra: Awaited<ReturnType<typeof startInfra>>;
  let coaching: CoachingService;
  let sessionBuffer: SessionBufferService;
  let journalSession: JournalSessionService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;

  const classify = jest.fn();
  const intentRoute = jest.fn();

  const makeDm = (discordId: string, content: string) =>
    ({
      author: { bot: false, id: discordId },
      channel: { isDMBased: () => true },
      content,
      reply: jest.fn().mockResolvedValue({}),
    }) as any;

  beforeAll(async () => {
    infra = await startInfra();
    process.env.DATABASE_URL = infra.postgresUrl;
    process.env.REDIS_URL = infra.redisUrl;

    delete (globalThis as { prisma?: unknown }).prisma;
    jest.resetModules();

    const { CoachingSessionService } = await import('../modules/session-buffer/coaching-session.service');
    const { SessionBufferService } = await import('../modules/session-buffer/session-buffer.service');
    const { BurstCoalescer } = await import('../modules/burst-coalescer/burst-coalescer.service');
    const { CoachingService } = await import('../modules/coaching/coaching.service');
    const { CoachHandler } = await import('../modules/coaching/coach-handler');
    const { DmRouterService } = await import('../modules/coaching/dm-router.service');
    const { JournalService } = await import('../modules/journal/journal.service');
    const { JournalDmHandler } = await import('../modules/journal/journal-dm.handler');
    const { JournalSessionService } = await import('../modules/journal/journal-session.service');
    const shared = await import('@wabi/shared');
    prisma = shared.prisma;

    const coachingSession = new CoachingSessionService();
    sessionBuffer = new SessionBufferService(infra.redisUrl);
    await sessionBuffer.init();
    journalSession = new JournalSessionService(infra.redisUrl);
    await journalSession.init();

    // Real writers where the test asserts persistence; mocked collaborators for everything else.
    const coach = { generate: jest.fn().mockResolvedValue('Glad you wrote this down.') } as any;
    const habitEngagement = { record: jest.fn().mockResolvedValue({ streak: 1, message: '', xpAwarded: 10 }) } as any;
    const journalService = new JournalService(coach, habitEngagement);
    const innerStateMemory = { deriveIfConsented: jest.fn().mockResolvedValue(undefined) } as any;
    const journalHandler = new JournalDmHandler(journalService, innerStateMemory, journalSession);

    const memoryStore = {
      deriveAndStore: jest.fn().mockResolvedValue(undefined),
      search: jest.fn().mockResolvedValue([]),
    } as any;
    const langfuseTracer = { trace: jest.fn() } as any;
    const coachHandler = new CoachHandler(coach, sessionBuffer, langfuseTracer, memoryStore, habitEngagement);
    const dmRouter = new DmRouterService(coachHandler, journalHandler, journalSession);

    const classifier = { classify } as any;
    const intentRouter = { route: intentRoute } as any;
    const strategyRetrieval = { search: jest.fn().mockResolvedValue([]) } as any;
    const burstCoalescer = new BurstCoalescer();
    const accessResolver = { resolve: jest.fn().mockResolvedValue({ hasActiveAccess: true }) } as any;
    const crisisAftermath = { isQuarantined: jest.fn().mockResolvedValue(false), onEscalation: jest.fn() } as any;
    const escalation = { escalate: jest.fn().mockResolvedValue('You matter. Here are some resources.') } as any;
    const tilt = {
      respondToPendingOffer: jest.fn().mockResolvedValue({ kind: 'none' }),
      maybeOffer: jest.fn().mockReturnValue(null),
      hasActiveSession: jest.fn().mockResolvedValue(false),
    } as any;
    const userService = {
      findByDiscordId: jest.fn(async (id: string) => ({ discordId: id, consentAcceptedAt: new Date(), timezone: 'UTC' })),
    } as any;

    coaching = new CoachingService(
      classifier,
      sessionBuffer,
      coachingSession,
      strategyRetrieval,
      burstCoalescer,
      langfuseTracer,
      accessResolver,
      crisisAftermath,
      escalation,
      tilt,
      userService,
      dmRouter,
      intentRouter,
      journalSession,
    );
  }, 60000);

  afterAll(async () => {
    await sessionBuffer?.disconnect();
    await journalSession?.disconnect();
    await prisma?.$disconnect();
    await infra.stop();
  }, 30000);

  beforeEach(() => {
    classify.mockReset();
    intentRoute.mockReset();
  });

  it('captures the second turn as a JournalEntry after a bare first turn, with nothing written on turn 1', async () => {
    const discordId = randomDiscordId();
    await prisma.user.create({ data: { discordId, consentAcceptedAt: new Date() } });

    // Turn 1: bare intent — confident journal, no inline content. Arms the capture, writes no entry.
    classify.mockResolvedValue('safe');
    intentRoute.mockResolvedValue({ intent: 'journal', confidence: 0.95 });
    await coaching.handle(makeDm(discordId, 'i want to journal'));

    expect(await journalSession.isPending(discordId)).toBe(true);
    expect(await prisma.journalEntry.count({ where: { userId: discordId } })).toBe(0);
    // The router LLM must NOT have been consulted on either turn (it's the bare turn that arms it, and
    // the capture turn skips it). Turn 1 DID call it (to get the journal verdict); turn 2 must not.
    expect(intentRoute).toHaveBeenCalledTimes(1);

    // Turn 2: the entry. Pending → router skipped → consumed → persisted verbatim.
    classify.mockResolvedValue('safe');
    await coaching.handle(makeDm(discordId, 'lost five ranked games in a row and i feel hopeless'));

    expect(intentRoute).toHaveBeenCalledTimes(1); // still 1 — skipped on the capture turn
    expect(await journalSession.isPending(discordId)).toBe(false); // consumed
    const entries = await prisma.journalEntry.findMany({ where: { userId: discordId } });
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('lost five ranked games in a row and i feel hopeless');
  });

  it('clears the pending marker and writes nothing when the capture turn is a crisis', async () => {
    const discordId = randomDiscordId();
    await prisma.user.create({ data: { discordId, consentAcceptedAt: new Date() } });

    // Turn 1: arm the capture.
    classify.mockResolvedValue('safe');
    intentRoute.mockResolvedValue({ intent: 'journal', confidence: 0.95 });
    await coaching.handle(makeDm(discordId, 'i want to journal'));
    expect(await journalSession.isPending(discordId)).toBe(true);

    // Turn 2: crisis. Marker cleared, no entry written, crisis text never persisted.
    classify.mockResolvedValue('crisis');
    await coaching.handle(makeDm(discordId, "i don't want to be here anymore"));

    expect(await journalSession.isPending(discordId)).toBe(false);
    expect(await prisma.journalEntry.count({ where: { userId: discordId } })).toBe(0);
  });
});
