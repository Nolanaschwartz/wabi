import { StreaksService } from '../streaks.service';
import { prisma } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  prisma: {
    xpEntry: { findFirst: jest.fn(), findMany: jest.fn() },
    journalEntry: { findMany: jest.fn() },
  },
}));

describe('StreaksService', () => {
  let service: StreaksService;

  beforeEach(() => {
    jest.clearAllMocks();
    // Streaks is a pure read model now — no XpService dependency (the one writer is HabitEngagement).
    service = new StreaksService();
  });

  it('starts a new streak (and a fresh engagement day) for a first-time user', async () => {
    (prisma.xpEntry.findFirst as jest.Mock).mockResolvedValue(null);

    const result = await service.advance('123');

    expect(result.streak).toBe(1);
    expect(result.message).toContain('Welcome');
    expect(result.isNewDay).toBe(true);
  });

  it('reports same-day activity as NOT a new engagement day (no second award/log)', async () => {
    (prisma.xpEntry.findFirst as jest.Mock).mockResolvedValue({
      createdAt: new Date(),
    });
    (prisma.xpEntry.findMany as jest.Mock).mockResolvedValue([]);

    const result = await service.advance('123');

    expect(result.message).toBe('');
    expect(result.isNewDay).toBe(false);
  });

  it('uses timezone for day boundaries', async () => {
    const yesterdayPacific = new Date();
    yesterdayPacific.setDate(yesterdayPacific.getDate() - 1);

    (prisma.xpEntry.findFirst as jest.Mock).mockResolvedValue({
      createdAt: yesterdayPacific,
    });
    (prisma.xpEntry.findMany as jest.Mock).mockResolvedValue([]);

    const result = await service.advance('123', 'America/Los_Angeles');

    expect(result.streak).toBeGreaterThanOrEqual(1);
    expect(result.isNewDay).toBe(true);
  });

  it('continues streak for consecutive day', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    (prisma.xpEntry.findFirst as jest.Mock).mockResolvedValue({
      createdAt: yesterday,
    });
    (prisma.xpEntry.findMany as jest.Mock).mockResolvedValue([]);

    const result = await service.advance('123');

    expect(result.message).toContain('streak continues');
    expect(result.isNewDay).toBe(true);
  });

  it('resets streak with compassion after long break', async () => {
    const lastWeek = new Date();
    lastWeek.setDate(lastWeek.getDate() - 7);

    (prisma.xpEntry.findFirst as jest.Mock).mockResolvedValue({
      createdAt: lastWeek,
    });

    const result = await service.advance('123');

    expect(result.streak).toBe(1);
    expect(result.message).toContain('Welcome back');
    expect(result.isNewDay).toBe(true);
  });

  it('returns profile with XP and wellness score', async () => {
    (prisma.xpEntry.findMany as jest.Mock).mockResolvedValue([]);

    const profile = await service.profile('123');

    expect(profile.xp).toBe(0);
    expect(profile.streak).toBe(0);
    expect(typeof profile.wellnessScore).toBe('number');
  });

  it('counts each Engagement once — a journal entry is not double-counted (ADR-0027)', async () => {
    // A journal write logs ONE Engagement row (reason 'journal'); Wellness reads the Engagement log
    // only, never adding journalEntry rows on top (the old double-count bug).
    const today = new Date();
    (prisma.xpEntry.findMany as jest.Mock).mockResolvedValue([
      { reason: 'journal', createdAt: today },
      { reason: 'coaching', createdAt: today },
    ]);

    await service.wellnessScore('123');

    expect(prisma.xpEntry.findMany).toHaveBeenCalled();
    // The journalEntry table is no longer part of the Wellness calculation.
    expect(prisma.journalEntry.findMany).not.toHaveBeenCalled();
  });

  it('wellness score reads only the Engagement log, never Mood or Tilt (ADR-0002)', async () => {
    (prisma.xpEntry.findMany as jest.Mock).mockResolvedValue([{ createdAt: new Date() }]);

    await service.wellnessScore('123');

    expect(prisma.xpEntry.findMany).toHaveBeenCalled();
  });
});
