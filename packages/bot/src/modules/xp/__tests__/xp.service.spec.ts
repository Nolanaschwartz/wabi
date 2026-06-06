import { XpService } from '../xp.service';
import { prisma } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  prisma: {
    xpEntry: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
  },
}));

describe('XpService', () => {
  let service: XpService;

  beforeEach(() => {
    service = new XpService();
    jest.clearAllMocks();
  });

  it('awards XP', async () => {
    (prisma.xpEntry.create as jest.Mock).mockResolvedValue({});
    await service.award('123', 10, 'journal');

    expect(prisma.xpEntry.create).toHaveBeenCalledWith({
      data: {
        userId: '123',
        amount: 10,
        reason: 'journal',
      },
    });
  });

  it('returns total XP', async () => {
    (prisma.xpEntry.findMany as jest.Mock).mockResolvedValue([
      { amount: 10 },
      { amount: 20 },
    ]);

    const total = await service.total('123');
    expect(total).toBe(30);
  });

  it('returns zero total when no entries', async () => {
    (prisma.xpEntry.findMany as jest.Mock).mockResolvedValue([]);
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
