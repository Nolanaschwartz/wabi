import { XpService } from '../xp.service';
import { prisma } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  prisma: {
    xpEntry: {
      create: jest.fn(),
      findMany: jest.fn(),
      aggregate: jest.fn(),
    },
  },
}));

describe('XpService', () => {
  let service: XpService;

  beforeEach(() => {
    service = new XpService();
    jest.clearAllMocks();
  });

  it('awards XP keyed on the person-tz engaged day (the per-day dedup unit)', async () => {
    (prisma.xpEntry.create as jest.Mock).mockResolvedValue({});
    await service.award('123', 10, 'journal', '2026-06-26');

    expect(prisma.xpEntry.create).toHaveBeenCalledWith({
      data: {
        userId: '123',
        amount: 10,
        reason: 'journal',
        engagedDay: '2026-06-26',
      },
    });
  });

  it('returns total XP via a database aggregate sum', async () => {
    (prisma.xpEntry.aggregate as jest.Mock).mockResolvedValue({
      _sum: { amount: 30 },
    });

    const total = await service.total('123');

    expect(total).toBe(30);
    expect(prisma.xpEntry.aggregate).toHaveBeenCalledWith({
      _sum: { amount: true },
      where: { userId: '123' },
    });
  });

  it('returns zero total when no entries (aggregate sum is null)', async () => {
    (prisma.xpEntry.aggregate as jest.Mock).mockResolvedValue({
      _sum: { amount: null },
    });

    const total = await service.total('123');

    expect(total).toBe(0);
  });

  it('returns recent entries', async () => {
    (prisma.xpEntry.findMany as jest.Mock).mockResolvedValue([
      { amount: 10, reason: 'journal', createdAt: new Date() },
    ]);

    const recent = await service.recent('123', 5);
    expect(recent.length).toBe(1);
    expect(recent[0].reason).toBe('journal');
  });
});
