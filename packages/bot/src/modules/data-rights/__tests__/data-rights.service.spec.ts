import { DataRightsService } from '../data-rights.service';
import { MemoryStoreService } from '../../memory/memory-store.service';
import { prisma } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    mood: { findMany: jest.fn(), deleteMany: jest.fn() },
    playtimeLog: { findMany: jest.fn(), deleteMany: jest.fn() },
    journalEntry: { findMany: jest.fn(), deleteMany: jest.fn() },
    xpEntry: { findMany: jest.fn(), deleteMany: jest.fn() },
    escalationEvent: { findMany: jest.fn(), deleteMany: jest.fn() },
    session: { findMany: jest.fn(), deleteMany: jest.fn() },
  },
}));

jest.mock('../../memory/memory-store.service', () => ({
  MemoryStoreService: jest.fn().mockImplementation(() => ({
    deleteAllForUser: jest.fn(),
  })),
}));

describe('DataRightsService', () => {
  let service: DataRightsService;
  let memoryStore: jest.Mocked<MemoryStoreService>;

  beforeEach(() => {
    jest.clearAllMocks();
    memoryStore = new MemoryStoreService() as any;
    service = new DataRightsService(memoryStore);
  });

  it('exports user data', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      discordId: '123',
      email: null,
      locale: 'en-US',
      createdAt: new Date(),
    });
    (prisma.mood.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.playtimeLog.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.journalEntry.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.xpEntry.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.escalationEvent.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.session.findMany as jest.Mock).mockResolvedValue([]);

    const data = await service.export('123');
    const parsed = JSON.parse(data);

    expect(parsed.user.discordId).toBe('123');
    expect(parsed.moods).toEqual([]);
  });

  it('deletes all user data', async () => {
    await service.delete('123');

    expect(memoryStore.deleteAllForUser).toHaveBeenCalledWith('123');
    expect(prisma.mood.deleteMany).toHaveBeenCalledWith({ where: { userId: '123' } });
    expect(prisma.playtimeLog.deleteMany).toHaveBeenCalledWith({ where: { userId: '123' } });
    expect(prisma.journalEntry.deleteMany).toHaveBeenCalledWith({ where: { userId: '123' } });
    expect(prisma.xpEntry.deleteMany).toHaveBeenCalledWith({ where: { userId: '123' } });
    expect(prisma.escalationEvent.deleteMany).toHaveBeenCalledWith({ where: { userId: '123' } });
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { userId: '123' } });
  });
});
