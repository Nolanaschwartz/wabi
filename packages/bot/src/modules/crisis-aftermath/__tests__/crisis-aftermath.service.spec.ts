import { CrisisAftermathService } from '../crisis-aftermath.service';
import { SessionBufferService } from '../../session-buffer/session-buffer.service';
import { ContactPolicyService } from '../../contact-policy/contact-policy.service';
import { prisma } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  prisma: {
    escalationEvent: {
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ timezone: 'UTC' }),
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
  let scheduler: { work: jest.Mock; sendAfter: jest.Mock; available: boolean };
  let client: { users: { send: jest.Mock } };
  let jobs: { declare: jest.Mock };
  let followUpHandler: (job: unknown[]) => Promise<void>;

  beforeEach(async () => {
    jest.clearAllMocks();
    sessionBuffer = new SessionBufferService() as any;
    sessionBuffer.clearAndQuarantine = jest.fn().mockResolvedValue(undefined);
    coachingSession = { quarantine: jest.fn().mockResolvedValue(undefined) };
    scheduler = {
      work: jest.fn().mockResolvedValue(undefined),
      sendAfter: jest.fn().mockResolvedValue(undefined),
      available: true,
    };
    client = { users: { send: jest.fn().mockResolvedValue(undefined) } };
    jobs = { declare: jest.fn() };
    service = new CrisisAftermathService(
      sessionBuffer,
      coachingSession as any,
      scheduler as any,
      client as any,
      new ContactPolicyService(),
      jobs as any,
    );
    service.init();
    // init() declares the follow-up worker; capture its handler to exercise the job directly.
    followUpHandler = jobs.declare.mock.calls[0]?.[0]?.handler;
  });

  it('clears buffer on escalation', async () => {
    await service.onEscalation('123');
    expect(sessionBuffer.clearAndQuarantine).toHaveBeenCalledWith('123');
  });

  it('sets the Postgres do-not-mine flag on escalation (single source of truth)', async () => {
    await service.onEscalation('123');
    expect(coachingSession.quarantine).toHaveBeenCalledWith('123');
  });

  it('enqueues the delayed follow-up as a one-off job (~30 min during waking hours)', async () => {
    await service.onEscalation('123');
    expect(scheduler.sendAfter).toHaveBeenCalledWith(
      'crisis-follow-up',
      expect.objectContaining({ userId: '123', message: expect.any(String) }),
      expect.any(Number),
    );
  });

  it('still quarantines but skips the follow-up when the Scheduler is degraded', async () => {
    scheduler.available = false;

    await service.onEscalation('123');

    // Safety state (do-not-mine + buffer clear) is unconditional; only the follow-up needs the queue.
    expect(coachingSession.quarantine).toHaveBeenCalledWith('123');
    expect(sessionBuffer.clearAndQuarantine).toHaveBeenCalledWith('123');
    expect(scheduler.sendAfter).not.toHaveBeenCalled();
  });

  it('delivers the gentle follow-up DM and records a content-free event when the job fires', async () => {
    await followUpHandler([{ userId: '123', message: 'How are you doing now?' }]);

    expect(client.users.send).toHaveBeenCalledWith('123', {
      content: 'How are you doing now?',
    });
    expect(prisma.escalationEvent.create).toHaveBeenCalledWith({
      data: { userId: '123', layer: 'follow-up' },
    });
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

    it('fails CLOSED on a Redis error: consults the durable EscalationEvent and quarantines if a recent escalation exists (ADR-0021)', async () => {
      sessionBuffer.getContext = jest.fn().mockRejectedValue(new Error('redis down')) as any;
      (prisma.escalationEvent.findFirst as jest.Mock).mockResolvedValue({
        userId: '123',
        layer: 'classifier',
      });

      await expect(service.isQuarantined('123')).resolves.toBe(true);
    });

    it('returns false on a Redis error when there is no recent escalation', async () => {
      sessionBuffer.getContext = jest.fn().mockRejectedValue(new Error('redis down')) as any;
      (prisma.escalationEvent.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.isQuarantined('123')).resolves.toBe(false);
    });
  });
});
