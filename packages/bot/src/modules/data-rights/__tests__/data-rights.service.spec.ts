import { DataRightsService } from '../data-rights.service';
import { MemoryStoreService } from '../../memory/memory-store.service';
import { SessionBufferService } from '../../session-buffer/session-buffer.service';
import { UserService } from '../../user/user.service';
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
  aiConversation: { deleteMany: jest.fn() },
  coachingSession: { deleteMany: jest.fn() },
};

jest.mock('@wabi/shared', () => ({
  prisma: {
    mood: { findMany: jest.fn(), deleteMany: jest.fn() },
    playtimeLog: { findMany: jest.fn(), deleteMany: jest.fn() },
    journalEntry: { findMany: jest.fn(), deleteMany: jest.fn() },
    xpEntry: { findMany: jest.fn(), deleteMany: jest.fn() },
    escalationEvent: { findMany: jest.fn(), deleteMany: jest.fn() },
    session: { findMany: jest.fn(), deleteMany: jest.fn() },
    tiltSession: { findMany: jest.fn(), deleteMany: jest.fn() },
    aiConversation: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn() },
    $transaction: jest.fn((fn) => fn(mockTx)),
  },
}));

jest.mock('../../memory/memory-store.service', () => ({
  MemoryStoreService: jest.fn().mockImplementation(() => ({
    deleteAllForUser: jest.fn(),
    getAllForUser: jest.fn(),
  })),
}));

jest.mock('../../session-buffer/session-buffer.service', () => ({
  SessionBufferService: jest.fn().mockImplementation(() => ({
    purge: jest.fn(),
  })),
}));

jest.mock('../../user/user.service', () => ({
  UserService: jest.fn().mockImplementation(() => ({
    findByDiscordId: jest.fn(),
  })),
}));

describe('DataRightsService', () => {
  let service: DataRightsService;
  let userService: jest.Mocked<UserService>;
  let memoryStore: jest.Mocked<MemoryStoreService>;
  let sessionBuffer: jest.Mocked<SessionBufferService>;

  beforeEach(() => {
    jest.clearAllMocks();
    userService = new UserService() as any;
    memoryStore = new MemoryStoreService() as any;
    sessionBuffer = new SessionBufferService() as any;
    service = new DataRightsService(userService, memoryStore, sessionBuffer);
  });

  it('exports user data including tilt sessions and memory', async () => {
    (userService.findByDiscordId as jest.Mock).mockResolvedValue({
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
    (userService.findByDiscordId as jest.Mock).mockResolvedValue({ discordId: '123' });
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

  it('purges the Redis session buffer + quarantine key (verbatim turns must not linger, ADR-0011)', async () => {
    await service.delete('123');

    expect(sessionBuffer.purge).toHaveBeenCalledWith('123');
  });

  it('surfaces a failure instead of silently swallowing a partial delete', async () => {
    (memoryStore.deleteAllForUser as jest.Mock).mockRejectedValue(new Error('mem0 down'));

    await expect(service.delete('123')).rejects.toThrow(/incomplete/i);
  });
});
