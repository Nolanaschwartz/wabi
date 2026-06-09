import { DataRightsService } from '../data-rights.service';
import { MemoryStoreService } from '../../memory/memory-store.service';
import { prisma } from '@wabi/shared';

// Capturable transaction client so tests can assert which deletes fired inside the atomic tx.
const mockTx = {
  mood: { deleteMany: jest.fn() },
  playtimeLog: { deleteMany: jest.fn() },
  journalEntry: { deleteMany: jest.fn() },
  xpEntry: { deleteMany: jest.fn() },
  escalationEvent: { deleteMany: jest.fn() },
  session: { deleteMany: jest.fn() },
  tiltSession: { deleteMany: jest.fn() },
  coachingSession: { deleteMany: jest.fn() },
};

jest.mock('@wabi/shared', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    mood: { findMany: jest.fn(), deleteMany: jest.fn() },
    playtimeLog: { findMany: jest.fn(), deleteMany: jest.fn() },
    journalEntry: { findMany: jest.fn(), deleteMany: jest.fn() },
    xpEntry: { findMany: jest.fn(), deleteMany: jest.fn() },
    escalationEvent: { findMany: jest.fn(), deleteMany: jest.fn() },
    session: { findMany: jest.fn(), deleteMany: jest.fn() },
    tiltSession: { findMany: jest.fn(), deleteMany: jest.fn() },
    $transaction: jest.fn((fn) => fn(mockTx)),
  },
}));

jest.mock('../../memory/memory-store.service', () => ({
  MemoryStoreService: jest.fn().mockImplementation(() => ({
    deleteAllForUser: jest.fn(),
    getAllForUser: jest.fn(),
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

  it('exports user data including tilt sessions and memory', async () => {
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
    (prisma.tiltSession.findMany as jest.Mock).mockResolvedValue([]);
    (memoryStore.getAllForUser as jest.Mock).mockResolvedValue([
      { id: 'm1', content: 'Tilts in ranked' },
    ]);

    const data = await service.export('123');
    const parsed = JSON.parse(data);

    expect(parsed.user.discordId).toBe('123');
    expect(parsed.tilt).toEqual([]);
    // #34: derived Memory is exported via getAllForUser (not the empty-query search).
    expect(memoryStore.getAllForUser).toHaveBeenCalledWith('123');
    expect(parsed.memory).toEqual([{ id: 'm1', content: 'Tilts in ranked' }]);
  });

  it('does not surface internal Coaching Session bookkeeping in the export', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ discordId: '123' });
    (prisma.mood.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.playtimeLog.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.journalEntry.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.xpEntry.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.escalationEvent.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.session.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.tiltSession.findMany as jest.Mock).mockResolvedValue([]);
    (memoryStore.getAllForUser as jest.Mock).mockResolvedValue([]);

    const parsed = JSON.parse(await service.export('123'));

    // Delete-only source: the row holds doNotMine/mined ops flags, never user-authored content.
    expect(parsed).not.toHaveProperty('coachingSession');
  });

  it('deletes all user data atomically in transaction', async () => {
    await service.delete('123');

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(memoryStore.deleteAllForUser).toHaveBeenCalledWith('123');
  });

  it('reaps the orphan-prone CoachingSession row (keyed by discordId, no User FK) inside the tx', async () => {
    await service.delete('123');

    // Regression: CoachingSession was in neither hand-list, so a /data delete left it behind.
    expect(mockTx.coachingSession.deleteMany).toHaveBeenCalledWith({
      where: { discordId: '123' },
    });
  });
});
