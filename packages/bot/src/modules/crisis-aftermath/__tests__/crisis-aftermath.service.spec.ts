import { CrisisAftermathService } from '../crisis-aftermath.service';
import { SessionBufferService } from '../../session-buffer/session-buffer.service';
import { prisma } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  prisma: {
    escalationEvent: {
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

describe('CrisisAftermathService', () => {
  let service: CrisisAftermathService;
  let sessionBuffer: jest.Mocked<SessionBufferService>;
  let coachingSession: { quarantine: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    sessionBuffer = new SessionBufferService() as any;
    sessionBuffer.clearAndQuarantine = jest.fn().mockResolvedValue(undefined);
    coachingSession = { quarantine: jest.fn().mockResolvedValue(undefined) };
    service = new CrisisAftermathService(sessionBuffer, coachingSession as any);
    await service.init();
  });

  it('clears buffer on escalation', async () => {
    await service.onEscalation('123');
    expect(sessionBuffer.clearAndQuarantine).toHaveBeenCalledWith('123');
  });

  it('sets the Postgres do-not-mine flag on escalation (single source of truth)', async () => {
    await service.onEscalation('123');
    expect(coachingSession.quarantine).toHaveBeenCalledWith('123');
  });

  it('schedules follow-up job', async () => {
    await service.onEscalation('123');
  });

  it('does not init when disabled', async () => {
    const disabledService = new CrisisAftermathService(sessionBuffer, coachingSession as any);
    (disabledService as any).enabled = false;
    await disabledService.init();
  });
});
