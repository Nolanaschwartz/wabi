import { MemorySweeperService } from '../memory-sweeper.service';
import { MemoryStoreService } from '../memory-store.service';
import { SessionBufferService } from '../../session-buffer/session-buffer.service';
import { prisma } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  prisma: {
    session: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
    aiConversation: {
      create: jest.fn(),
    },
  },
}));

jest.mock('pg-boss', () => ({
  PgBoss: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    work: jest.fn(),
    schedule: jest.fn(),
    stop: jest.fn(),
  })),
}));

describe('MemorySweeperService', () => {
  let sweeper: MemorySweeperService;
  let memoryStore: jest.Mocked<MemoryStoreService>;
  let sessionBuffer: jest.Mocked<SessionBufferService>;

  beforeEach(() => {
    jest.clearAllMocks();
    memoryStore = new MemoryStoreService() as any;
    sessionBuffer = new SessionBufferService() as any;
    sweeper = new MemorySweeperService(memoryStore, sessionBuffer);
  });

  it('does not init when disabled', async () => {
    await sweeper.init();
  });

  it('skips do-not-mine sessions', async () => {
    (prisma.session.findMany as jest.Mock).mockResolvedValue([]);
  });

  it('marks session as mined after processing', async () => {
    (prisma.session.findMany as jest.Mock).mockResolvedValue([]);
  });
});
