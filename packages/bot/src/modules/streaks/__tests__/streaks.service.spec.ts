import { StreaksService } from '../streaks.service';
import { prisma } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  prisma: {
    xpEntry: { findFirst: jest.fn(), findMany: jest.fn() },
    mood: { findMany: jest.fn() },
    journalEntry: { findMany: jest.fn() },
  },
}));

describe('StreaksService', () => {
  let service: StreaksService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new StreaksService();
  });

  it('returns streak 1 for new user', async () => {
    (prisma.xpEntry.findFirst as jest.Mock).mockResolvedValue(null);

    const result = await service.checkAndAward('123');

    expect(result.streak).toBe(1);
    expect(result.message).toContain('Welcome');
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
    (prisma.mood.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.journalEntry.findMany as jest.Mock).mockResolvedValue([]);

    const profile = await service.profile('123');

    expect(profile.xp).toBe(0);
    expect(profile.streak).toBe(0);
    expect(typeof profile.wellnessScore).toBe('number');
  });
});
