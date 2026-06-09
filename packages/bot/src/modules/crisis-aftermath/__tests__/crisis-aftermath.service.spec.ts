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

// Mocking the Scheduler also keeps pg-boss (ESM) out of the import graph.
jest.mock('../../scheduler/scheduler.service', () => ({
  SchedulerService: jest.fn(),
}));

describe('CrisisAftermathService', () => {
  let service: CrisisAftermathService;
  let sessionBuffer: jest.Mocked<SessionBufferService>;
  let coachingSession: { quarantine: jest.Mock };
  let scheduler: { work: jest.Mock; schedule: jest.Mock; available: boolean };

  beforeEach(async () => {
    jest.clearAllMocks();
    sessionBuffer = new SessionBufferService() as any;
    sessionBuffer.clearAndQuarantine = jest.fn().mockResolvedValue(undefined);
    coachingSession = { quarantine: jest.fn().mockResolvedValue(undefined) };
    scheduler = {
      work: jest.fn().mockResolvedValue(undefined),
      schedule: jest.fn().mockResolvedValue(undefined),
      available: true,
    };
    service = new CrisisAftermathService(sessionBuffer, coachingSession as any, scheduler as any);
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

  it('schedules the delayed follow-up through the Scheduler', async () => {
    await service.onEscalation('123');
    expect(scheduler.schedule).toHaveBeenCalledWith(
      'crisis-follow-up',
      '30 minutes',
      expect.objectContaining({ userId: '123' }),
    );
  });

  it('still quarantines but skips the follow-up when the Scheduler is degraded', async () => {
    scheduler.available = false;

    await service.onEscalation('123');

    // Safety state (do-not-mine + buffer clear) is unconditional; only the follow-up needs the queue.
    expect(coachingSession.quarantine).toHaveBeenCalledWith('123');
    expect(sessionBuffer.clearAndQuarantine).toHaveBeenCalledWith('123');
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  describe('isQuarantined (reads the buffer through its interface, not the raw client)', () => {
    it('returns false when a live session exists, even if the window is set (policy: a fresh session cancels aftermath)', async () => {
      sessionBuffer.getContext = jest.fn().mockResolvedValue({ turns: [] }) as any;
      sessionBuffer.inAftermathWindow = jest.fn().mockResolvedValue(true) as any;

      await expect(service.isQuarantined('123')).resolves.toBe(false);
      expect(sessionBuffer.inAftermathWindow).not.toHaveBeenCalled();
    });

    it('returns true when there is no live session and the aftermath window is set', async () => {
      sessionBuffer.getContext = jest.fn().mockResolvedValue(null) as any;
      sessionBuffer.inAftermathWindow = jest.fn().mockResolvedValue(true) as any;

      await expect(service.isQuarantined('123')).resolves.toBe(true);
    });

    it('returns false when there is no live session and no aftermath window', async () => {
      sessionBuffer.getContext = jest.fn().mockResolvedValue(null) as any;
      sessionBuffer.inAftermathWindow = jest.fn().mockResolvedValue(false) as any;

      await expect(service.isQuarantined('123')).resolves.toBe(false);
    });
  });
});
