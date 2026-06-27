import { StreaksService } from '../streaks.service';
import { prisma } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  prisma: {
    xpEntry: { findMany: jest.fn(), count: jest.fn() },
    journalEntry: { findMany: jest.fn() },
  },
}));

// Build an engagement row N whole days before now. advance/getCurrentStreak read `new Date()`
// internally, so scenarios are anchored relative to the real clock.
function daysAgo(n: number): { createdAt: Date } {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return { createdAt: d };
}

describe('StreaksService', () => {
  let service: StreaksService;

  beforeEach(() => {
    jest.clearAllMocks();
    // A pure read model over the Engagement log (xpEntry) — no XP collaborator. The cross-cutting
    // profile aggregation moved up to HabitEngagementService (ADR-0027).
    service = new StreaksService();
  });

  it('starts a new streak (and a fresh engagement day) for a first-time user', async () => {
    (prisma.xpEntry.findMany as jest.Mock).mockResolvedValue([]);

    const result = await service.advance('123');

    expect(result.streak).toBe(1);
    expect(result.message).toContain('Welcome');
    expect(result.isNewDay).toBe(true);
  });

  it('reports same-day activity as NOT a new engagement day (no second award/log)', async () => {
    // One row already exists for today: the streak is unchanged and nothing new is logged.
    (prisma.xpEntry.findMany as jest.Mock).mockResolvedValue([daysAgo(0)]);

    const result = await service.advance('123');

    expect(result.streak).toBe(1);
    expect(result.message).toBe('');
    expect(result.isNewDay).toBe(false);
  });

  it('uses timezone for day boundaries', async () => {
    (prisma.xpEntry.findMany as jest.Mock).mockResolvedValue([daysAgo(1)]);

    const result = await service.advance('123', 'America/Los_Angeles');

    expect(result.streak).toBeGreaterThanOrEqual(1);
    expect(result.isNewDay).toBe(true);
  });

  it('continues the streak for a consecutive day, growing the NUMBER past 1', async () => {
    // A 3-day run ending yesterday; engaging today should read 4 (the bug made this stick at 1).
    (prisma.xpEntry.findMany as jest.Mock).mockResolvedValue([
      daysAgo(1),
      daysAgo(2),
      daysAgo(3),
    ]);

    const result = await service.advance('123');

    expect(result.streak).toBe(4);
    expect(result.message).toContain('streak continues');
    expect(result.isNewDay).toBe(true);
  });

  it('celebrates with the 🔥 tier once the streak reaches 7+', async () => {
    // A 6-day run ending yesterday → today makes it 7.
    (prisma.xpEntry.findMany as jest.Mock).mockResolvedValue(
      [1, 2, 3, 4, 5, 6].map((n) => daysAgo(n)),
    );

    const result = await service.advance('123');

    expect(result.streak).toBe(7);
    expect(result.message).toContain('🔥');
    expect(result.isNewDay).toBe(true);
  });

  it('forgives a single missed day (grace), preserving and extending the NUMBER', async () => {
    // A 3-day run ending 2 days ago — one day missed. Today's engagement is forgiven and continues it.
    (prisma.xpEntry.findMany as jest.Mock).mockResolvedValue([
      daysAgo(2),
      daysAgo(3),
      daysAgo(4),
    ]);

    const result = await service.advance('123');

    expect(result.streak).toBe(4);
    expect(result.message).toContain('No worries about the break');
    expect(result.isNewDay).toBe(true);
  });

  it('resets streak with compassion after long break', async () => {
    (prisma.xpEntry.findMany as jest.Mock).mockResolvedValue([daysAgo(7)]);

    const result = await service.advance('123');

    expect(result.streak).toBe(1);
    expect(result.message).toContain('Welcome back');
    expect(result.isNewDay).toBe(true);
  });

  it('getCurrentStreak issues a single query and returns the run length', async () => {
    (prisma.xpEntry.findMany as jest.Mock).mockResolvedValue([
      daysAgo(0),
      daysAgo(1),
      daysAgo(2),
    ]);

    const streak = await service.getCurrentStreak('123');

    expect(streak).toBe(3);
    expect(prisma.xpEntry.findMany).toHaveBeenCalledTimes(1);
  });

  it('counts each Engagement once — a journal entry is not double-counted (ADR-0027)', async () => {
    // A journal write logs ONE Engagement row (reason 'journal'); Wellness counts the Engagement log
    // only, never adding journalEntry rows on top (the old double-count bug). Two engaged rows → a
    // count of 2 → score round((2 / 30) * 100) = 7.
    (prisma.xpEntry.count as jest.Mock).mockResolvedValue(2);

    const result = await service.wellnessScore('123');

    expect(result.score).toBe(7);
    expect(prisma.xpEntry.count).toHaveBeenCalled();
    // The journalEntry table is no longer part of the Wellness calculation.
    expect(prisma.journalEntry.findMany).not.toHaveBeenCalled();
  });

  it('wellness score counts only the Engagement log over the trailing 30 days (ADR-0002)', async () => {
    (prisma.xpEntry.count as jest.Mock).mockResolvedValue(15);

    const result = await service.wellnessScore('123');

    // round((15 / 30) * 100) = 50 → '🌱 Wellness Starter' tier.
    expect(result.score).toBe(50);
    expect(result.level).toBe('🌱 Wellness Starter');
    expect(prisma.xpEntry.count).toHaveBeenCalledWith({
      where: { userId: '123', createdAt: { gte: expect.any(Date) } },
    });
    // Never reads Mood or Tilt tables.
  });

  it('wellness score caps at 100 and never reads beyond the Engagement log', async () => {
    (prisma.xpEntry.count as jest.Mock).mockResolvedValue(45);

    const result = await service.wellnessScore('123');

    // round((45 / 30) * 100) = 150 → clamped to 100 → '🌟 Wellness Champion'.
    expect(result.score).toBe(100);
    expect(result.level).toBe('🌟 Wellness Champion');
    expect(prisma.xpEntry.findMany).not.toHaveBeenCalled();
  });
});
