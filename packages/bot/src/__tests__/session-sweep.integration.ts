// pg-boss is ESM and only used by SessionSweeper's cron scheduling (onModuleInit),
// which this test never invokes — it drives sweep() directly. Mock it so jest can
// parse the import while Postgres + Redis remain real.
jest.mock('pg-boss', () => ({
  PgBoss: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    createQueue: jest.fn().mockResolvedValue(undefined),
    schedule: jest.fn().mockResolvedValue(undefined),
    work: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { startInfra, createTestPrisma, randomDiscordId } from '../integration-harness';
import { CoachingSessionService } from '../modules/session-buffer/coaching-session.service';
import { SessionBufferService } from '../modules/session-buffer/session-buffer.service';
import { SessionSweeper } from '../modules/session-buffer/session-sweeper.service';

describe('session sweep integration', () => {
  let infra: Awaited<ReturnType<typeof startInfra>>;
  let coachingSession: CoachingSessionService;
  let sessionBuffer: SessionBufferService;
  let sweeper: SessionSweeper;

  beforeAll(async () => {
    infra = await startInfra();
    process.env.DATABASE_URL = infra.postgresUrl;
    process.env.REDIS_URL = infra.redisUrl;

    // The @wabi/shared prisma singleton is constructed at module-load time (when the
    // static service imports above ran, before DATABASE_URL pointed at the container) and
    // cached on globalThis. Drop that cached client so the re-import below reconstructs it
    // against the test database.
    delete (globalThis as { prisma?: unknown }).prisma;

    // Force reload of @wabi/shared with the test DATABASE_URL
    jest.resetModules();
    const { CoachingSessionService: CCS } = await import('../modules/session-buffer/coaching-session.service');
    const { SessionBufferService: SBS } = await import('../modules/session-buffer/session-buffer.service');
    coachingSession = new CCS();
    sessionBuffer = new SBS(infra.redisUrl);
    await sessionBuffer.init();

    // Memory store is disabled (no MEM0_URL), so sweeper degrades gracefully
    const { MemoryStoreService } = await import('../modules/memory/memory-store.service');
    const memoryStore = new MemoryStoreService();
    const { SessionSweeper: SS } = await import('../modules/session-buffer/session-sweeper.service');
    // Scheduler is unused here — the test invokes sweep() directly, not the cron registration.
    const scheduler = { cron: async () => undefined } as any;
    sweeper = new SS(coachingSession, sessionBuffer, memoryStore, scheduler);
  }, 60000);

  afterAll(async () => {
    await sessionBuffer?.disconnect();
    const { prisma } = await import('@wabi/shared');
    await prisma.$disconnect();
    await infra.stop();
  }, 30000);

  it('end-stale → mine → mark-mined pipeline', async () => {
    const discordId = randomDiscordId();

    // Create a session with old activity
    const session = await coachingSession.touch(discordId);
    // Backdate lastActivity so it appears stale
    await createTestPrisma(infra.postgresUrl).coachingSession.update({
      where: { id: session.id },
      data: { lastActivity: new Date(Date.now() - 61 * 60 * 1000) },
    });

    // Buffer turns
    await sessionBuffer.append(discordId, 'user', 'I need help');
    await sessionBuffer.append(discordId, 'assistant', 'I can help with that');

    const ctx = await sessionBuffer.getContext(discordId);
    expect(ctx?.turns.length).toBe(2);

    // Sweep with 1-hour threshold
    const result = await sweeper.sweep();
    expect(result.sessionsEnded).toBeGreaterThanOrEqual(1);
    expect(result.mined).toBeGreaterThanOrEqual(1);

    // Session should be marked mined
    const { prisma } = await import('@wabi/shared');
    const stored = await prisma.coachingSession.findUnique({ where: { discordId } });
    expect(stored?.mined).toBe(true);
  }, 30000);

  it('skips quarantined sessions', async () => {
    const discordId = randomDiscordId();

    await coachingSession.quarantine(discordId);
    await createTestPrisma(infra.postgresUrl).coachingSession.update({
      where: { discordId },
      data: { lastActivity: new Date(Date.now() - 61 * 60 * 1000), mined: false },
    });

    const result = await sweeper.sweep();
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.mined).toBe(0);

    const { prisma } = await import('@wabi/shared');
    const stored = await prisma.coachingSession.findUnique({ where: { discordId } });
    expect(stored?.doNotMine).toBe(true);
    expect(stored?.mined).toBe(true);
  }, 30000);
});
