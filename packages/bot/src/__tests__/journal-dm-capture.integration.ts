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
import type { SpokeSessionService } from '../modules/spoke-session/spoke-session.service';
import type { CoachingService } from '../modules/coaching/coaching.service';

// The two-turn conversational journal capture, end-to-end against real Postgres + Redis. A bare "i want
// to journal" arms the spoke floor (Redis) and writes NO entry; the next DM is consumed and persisted
// as a JournalEntry (Postgres). A crisis on the capture turn clears the floor and saves nothing — the
// crisis text never reaches the journal writer (ADR-0021/0028).
describe('Journal DM two-turn capture integration', () => {
  let infra: Awaited<ReturnType<typeof startInfra>>;
  let coaching: CoachingService;
  let sessionBuffer: SessionBufferService;
  let spokeSession: SpokeSessionService;
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
    const { InnerStateRecorderService } = await import('../modules/inner-state-logger/inner-state-recorder.service');
    const { SpokeSessionService } = await import('../modules/spoke-session/spoke-session.service');
    const shared = await import('@wabi/shared');
    prisma = shared.prisma;

    const coachingSession = new CoachingSessionService();
    sessionBuffer = new SessionBufferService(infra.redisUrl);
    await sessionBuffer.init();
    spokeSession = new SpokeSessionService(infra.redisUrl);
    await spokeSession.init();

    // Real writers where the test asserts persistence; mocked collaborators for everything else.
    const coach = {
      generate: jest.fn().mockResolvedValue('Glad you wrote this down.'),
      generateDetailed: jest.fn().mockResolvedValue({
        text: 'Glad you wrote this down.',
        model: 'test-coach',
      }),
    } as any;
    const habitEngagement = { record: jest.fn().mockResolvedValue({ streak: 1, message: '', xpAwarded: 10 }) } as any;
    const journalService = new JournalService(coach, habitEngagement);
    // The DM handler is now the DM adapter over the transport-free recorder (ADR-0031): it mints a
    // Screened proof from the upstream verdict (no re-screen) and runs the shared persist→derive→consent
    // tail. Use the real recorder with mocked memory/consent so the entry still persists for real.
    const innerStateMemory = { deriveIfConsented: jest.fn().mockResolvedValue(undefined) } as any;
    const consent = { prepareFirstUsePrompt: jest.fn().mockResolvedValue(null) } as any;
    const recorder = new InnerStateRecorderService(innerStateMemory, consent);
    const screening = {
      screenedFromUpstream: (content: string, derivePrefix: string) => ({ freeText: content, derivePrefix }),
    } as any;
    const journalHandler = new JournalDmHandler(journalService, screening, recorder, spokeSession);

    const memoryStore = {
      deriveAndStore: jest.fn().mockResolvedValue(undefined),
      search: jest.fn().mockResolvedValue([]),
    } as any;
    const langfuseTracer = { span: jest.fn(), score: jest.fn(), traceObservation: jest.fn(), latchCrisis: jest.fn() } as any;
    const coachHandler = new CoachHandler(coach, sessionBuffer, langfuseTracer, memoryStore, habitEngagement, { tracer: {} } as any);
    const classifier = { classify } as any;
    const intentRouter = { route: intentRoute } as any;
    // tilt/mood spokes aren't exercised here, but the router projects every registered spoke into its
    // catalogue at construction, so each must satisfy the Spoke contract (intent/description/tools/defaultTool).
    const tiltDmHandler = {
      intent: 'tilt',
      description: 'tilt',
      tools: [],
      defaultTool: 'offer_session',
      invoke: jest.fn().mockResolvedValue({ kind: 'fallthrough' }),
      resume: jest.fn().mockResolvedValue({ kind: 'fallthrough' }),
    } as any;
    const moodDmHandler = {
      intent: 'mood',
      description: 'mood',
      tools: [],
      defaultTool: 'log_mood',
      invoke: jest.fn().mockResolvedValue({ kind: 'handled' }),
      resume: jest.fn().mockResolvedValue({ kind: 'handled' }),
    } as any;
    const dmRouter = new DmRouterService(
      coachHandler,
      journalHandler,
      spokeSession,
      intentRouter,
      tiltDmHandler,
      moodDmHandler,
    );
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
    );
  }, 60000);

  afterAll(async () => {
    await sessionBuffer?.disconnect();
    await spokeSession?.disconnect();
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

    expect(await spokeSession.active(discordId)).toBe('journal');
    expect(await prisma.journalEntry.count({ where: { userId: discordId } })).toBe(0);
    // The router LLM must NOT have been consulted on either turn (it's the bare turn that arms it, and
    // the capture turn skips it). Turn 1 DID call it (to get the journal verdict); turn 2 must not.
    expect(intentRoute).toHaveBeenCalledTimes(1);

    // Turn 2: the entry. Pending → router skipped → consumed → persisted verbatim.
    classify.mockResolvedValue('safe');
    await coaching.handle(makeDm(discordId, 'lost five ranked games in a row and i feel hopeless'));

    expect(intentRoute).toHaveBeenCalledTimes(1); // still 1 — skipped on the capture turn
    expect(await spokeSession.active(discordId)).toBeNull(); // consumed
    const entries = await prisma.journalEntry.findMany({ where: { userId: discordId } });
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('lost five ranked games in a row and i feel hopeless');
  });

  it('treats a request for a prompt as give_prompt: arms the floor, writes no entry', async () => {
    const discordId = randomDiscordId();
    await prisma.user.create({ data: { discordId, consentAcceptedAt: new Date() } });

    // The bug: "i need a journal entry prompt" is a REQUEST, not an entry. The discovery classifier tags
    // it give_prompt → the hub prompts and arms the floor, persisting nothing on this turn.
    classify.mockResolvedValue('safe');
    intentRoute.mockResolvedValue({ intent: 'journal', confidence: 0.95, tool: 'give_prompt' });
    const dm = makeDm(discordId, 'i need a journal entry prompt');
    await coaching.handle(dm);

    expect(await spokeSession.active(discordId)).toBe('journal'); // floor armed for the next turn
    expect(await prisma.journalEntry.count({ where: { userId: discordId } })).toBe(0); // nothing saved
    expect(dm.reply).toHaveBeenCalled(); // a prompt was sent back
  });

  it('clears the pending marker and writes nothing when the capture turn is a crisis', async () => {
    const discordId = randomDiscordId();
    await prisma.user.create({ data: { discordId, consentAcceptedAt: new Date() } });

    // Turn 1: arm the capture.
    classify.mockResolvedValue('safe');
    intentRoute.mockResolvedValue({ intent: 'journal', confidence: 0.95 });
    await coaching.handle(makeDm(discordId, 'i want to journal'));
    expect(await spokeSession.active(discordId)).toBe('journal');

    // Turn 2: crisis. Floor cleared, no entry written, crisis text never persisted.
    classify.mockResolvedValue('crisis');
    await coaching.handle(makeDm(discordId, "i don't want to be here anymore"));

    expect(await spokeSession.active(discordId)).toBeNull();
    expect(await prisma.journalEntry.count({ where: { userId: discordId } })).toBe(0);
  });
});
