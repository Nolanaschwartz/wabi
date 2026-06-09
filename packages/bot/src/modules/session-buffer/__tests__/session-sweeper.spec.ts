import { SessionSweeper } from '../session-sweeper.service';
import { CoachingSessionService } from '../coaching-session.service';
import { SessionBufferService } from '../session-buffer.service';
import { MemoryStoreService } from '../../memory/memory-store.service';

jest.mock('../coaching-session.service', () => ({
  CoachingSessionService: jest.fn().mockImplementation(() => ({
    endStale: jest.fn(),
    markMined: jest.fn(),
  })),
}));

jest.mock('../session-buffer.service', () => ({
  SessionBufferService: jest.fn().mockImplementation(() => ({
    getContext: jest.fn(),
    clear: jest.fn(),
  })),
}));

jest.mock('../../memory/memory-store.service', () => ({
  MemoryStoreService: jest.fn().mockImplementation(() => ({
    deriveAndStore: jest.fn(),
  })),
}));

jest.mock('../../scheduler/scheduler.service', () => ({
  SchedulerService: jest.fn().mockImplementation(() => ({
    cron: jest.fn().mockResolvedValue(undefined),
    work: jest.fn().mockResolvedValue(undefined),
    available: true,
  })),
}));

import { SchedulerService } from '../../scheduler/scheduler.service';

const mockSession = (id: string, discordId: string, doNotMine: boolean = false) => ({
  id,
  discordId,
  expiresAt: new Date(),
  lastActivity: new Date(Date.now() - 60 * 60 * 1000),
  mined: false,
  doNotMine,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('SessionSweeper', () => {
  let sweeper: SessionSweeper;
  let coachingSession: jest.Mocked<CoachingSessionService>;
  let sessionBuffer: jest.Mocked<SessionBufferService>;
  let memoryStore: jest.Mocked<MemoryStoreService>;

  beforeEach(() => {
    jest.clearAllMocks();
    coachingSession = new CoachingSessionService() as any;
    sessionBuffer = new SessionBufferService() as any;
    memoryStore = new MemoryStoreService() as any;
    const scheduler = new SchedulerService() as any;
    sweeper = new SessionSweeper(coachingSession, sessionBuffer, memoryStore, scheduler);
  });

  it('mines one extraction per ended session', async () => {
    coachingSession.endStale.mockResolvedValue([
      mockSession('sess-1', '123'),
    ]);
    sessionBuffer.getContext.mockResolvedValue({
      sessionId: 'sess-1',
      turns: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
      lastSeen: new Date(),
      doNotMine: false,
    });
    memoryStore.deriveAndStore.mockResolvedValue();
    coachingSession.markMined.mockResolvedValue();

    const result = await sweeper.sweep();

    expect(result.sessionsEnded).toBe(1);
    expect(result.mined).toBe(1);
    expect(result.skipped).toBe(0);
    expect(memoryStore.deriveAndStore).toHaveBeenCalled();
    expect(coachingSession.markMined).toHaveBeenCalledWith('sess-1');
  });

  it('skips quarantined sessions', async () => {
    coachingSession.endStale.mockResolvedValue([
      mockSession('sess-2', '456', true),
    ]);
    coachingSession.markMined.mockResolvedValue();

    const result = await sweeper.sweep();

    expect(result.skipped).toBe(1);
    expect(result.mined).toBe(0);
    expect(memoryStore.deriveAndStore).not.toHaveBeenCalled();
    expect(coachingSession.markMined).toHaveBeenCalledWith('sess-2');
  });

  it('handles empty sweep', async () => {
    coachingSession.endStale.mockResolvedValue([]);

    const result = await sweeper.sweep();

    expect(result.sessionsEnded).toBe(0);
    expect(result.mined).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('clears buffer after mining', async () => {
    coachingSession.endStale.mockResolvedValue([
      mockSession('sess-1', '123'),
    ]);
    sessionBuffer.getContext.mockResolvedValue({
      sessionId: 'sess-1',
      turns: [{ role: 'user', content: 'hello' }],
      lastSeen: new Date(),
      doNotMine: false,
    });
    memoryStore.deriveAndStore.mockResolvedValue();
    sessionBuffer.clear.mockResolvedValue();
    coachingSession.markMined.mockResolvedValue();

    await sweeper.sweep();

    expect(sessionBuffer.clear).toHaveBeenCalledWith('123');
  });

  it('handles missing buffer gracefully', async () => {
    coachingSession.endStale.mockResolvedValue([
      mockSession('sess-1', '123'),
    ]);
    sessionBuffer.getContext.mockResolvedValue(null);
    coachingSession.markMined.mockResolvedValue();

    await sweeper.sweep();

    expect(memoryStore.deriveAndStore).not.toHaveBeenCalled();
    expect(sessionBuffer.clear).not.toHaveBeenCalled();
    expect(coachingSession.markMined).toHaveBeenCalledWith('sess-1');
  });
});
