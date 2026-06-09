import { StreaksService } from '../streaks.service';
import { XpService } from '../../xp/xp.service';
import { prisma } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  prisma: {
    xpEntry: { findFirst: jest.fn(), findMany: jest.fn() },
    journalEntry: { findMany: jest.fn() },
  },
}));

jest.mock('../../xp/xp.service', () => ({
  XpService: jest.fn().mockImplementation(() => ({
    award: jest.fn(),
  })),
}));

describe('StreaksService', () => {
  let service: StreaksService;
  let xp: jest.Mocked<XpService>;

  beforeEach(() => {
    jest.clearAllMocks();
    xp = new XpService() as any;
    service = new StreaksService(xp);
  });

  it('returns streak 1 for new user', async () => {
    (prisma.xpEntry.findFirst as jest.Mock).mockResolvedValue(null);

    const result = await service.checkAndAward('123');

    expect(result.streak).toBe(1);
    expect(result.message).toContain('Welcome');
    // The XP ledger has one writer: streaks awards through XpService, never raw xpEntry.create.
    expect(xp.award).toHaveBeenCalledWith('123', 10, 'coaching');
  });

  it('skips XP award on same-day activity', async () => {
    (prisma.xpEntry.findFirst as jest.Mock).mockResolvedValue({
      createdAt: new Date(),
    });
    (prisma.xpEntry.findMany as jest.Mock).mockResolvedValue([]);

    const result = await service.checkAndAward('123');

    expect(result.message).toBe('');
    expect(xp.award).not.toHaveBeenCalled();
  });

  it('uses timezone for day boundaries', async () => {
    const yesterdayPacific = new Date();
    yesterdayPacific.setDate(yesterdayPacific.getDate() - 1);

    (prisma.xpEntry.findFirst as jest.Mock).mockResolvedValue({
      createdAt: yesterdayPacific,
    });
    (prisma.xpEntry.findMany as jest.Mock).mockResolvedValue([]);

    const result = await service.checkAndAward('123', 'America/Los_Angeles');

    expect(result.streak).toBeGreaterThanOrEqual(1);
    expect(xp.award).toHaveBeenCalled();
  });

  it('continues streak for consecutive day', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    (prisma.xpEntry.findFirst as jest.Mock).mockResolvedValue({
      createdAt: yesterday,
    });
    (prisma.xpEntry.findMany as jest.Mock).mockResolvedValue([]);

    const result = await service.checkAndAward('123');

    expect(result.message).toContain('streak continues');
  });

  it('resets streak with compassion after long break', async () => {
    const lastWeek = new Date();
    lastWeek.setDate(lastWeek.getDate() - 7);

    (prisma.xpEntry.findFirst as jest.Mock).mockResolvedValue({
      createdAt: lastWeek,
    });

    const result = await service.checkAndAward('123');

    expect(result.streak).toBe(1);
    expect(result.message).toContain('Welcome back');
  });

  it('returns profile with XP and wellness score', async () => {
    (prisma.xpEntry.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.journalEntry.findMany as jest.Mock).mockResolvedValue([]);

    const profile = await service.profile('123');

    expect(profile.xp).toBe(0);
    expect(profile.streak).toBe(0);
    expect(typeof profile.wellnessScore).toBe('number');
  });

  it('wellness score never reads Mood or Tilt data (privacy)', async () => {
    (prisma.xpEntry.findMany as jest.Mock).mockResolvedValue([{ createdAt: new Date() }]);
    (prisma.journalEntry.findMany as jest.Mock).mockResolvedValue([]);

    await service.wellnessScore('123');

    // wellnessScore should only query xpEntry and journalEntry, never mood/tilt
    expect(prisma.xpEntry.findMany).toHaveBeenCalled();
    expect(prisma.journalEntry.findMany).toHaveBeenCalled();
  });
});
