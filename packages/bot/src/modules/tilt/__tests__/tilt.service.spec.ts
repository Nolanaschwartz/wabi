import { TiltService } from '../tilt.service';
import { StrategyRetrievalService } from '../../strategy-retrieval/strategy-retrieval.service';
import { prisma } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  prisma: {
    tiltSession: {
      create: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));

jest.mock('../../strategy-retrieval/strategy-retrieval.service', () => ({
  StrategyRetrievalService: jest.fn().mockImplementation(() => ({
    search: jest.fn(),
  })),
}));

jest.mock('../../scheduler/scheduler.service', () => ({
  SchedulerService: jest.fn().mockImplementation(() => ({
    cron: jest.fn().mockResolvedValue(undefined),
    work: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue(undefined),
    schedule: jest.fn().mockResolvedValue(undefined),
    available: true,
  })),
}));

import { SchedulerService } from '../../scheduler/scheduler.service';

// TiltService is now a plain persist + state-machine service: crisis screening of the trigger and the
// consent-gated derivation moved to InnerStateLogger (ADR-0028/0029). `acceptOffer` is the shared
// create primitive the `/tilt start` controller persists through.
describe('TiltService', () => {
  let service: TiltService;
  let strategyRetrieval: jest.Mocked<StrategyRetrievalService>;
  let scheduler: jest.Mocked<SchedulerService>;

  beforeEach(() => {
    jest.clearAllMocks();
    strategyRetrieval = new StrategyRetrievalService() as any;
    scheduler = new SchedulerService() as any;
    service = new TiltService(strategyRetrieval, scheduler);
  });

  it('detects tilt language', () => {
    expect(service.isTiltLanguage("I'm so frustrated")).toBe(true);
    expect(service.isTiltLanguage('tilt is real')).toBe(true);
    expect(service.isTiltLanguage('good game')).toBe(false);
  });

  it('detects the specific trigger keyword in text', () => {
    expect(service.detectTrigger('my teammates are feeding so hard')).toBe('feeding');
    expect(service.detectTrigger('what a good game')).toBeNull();
  });

  it('stores, reads, and clears a pending offer', () => {
    expect(service.getPendingOffer('123')).toBeNull();
    service.setPendingOffer('123', 'raging');
    expect(service.getPendingOffer('123')).toBe('raging');
    service.clearPendingOffer('123');
    expect(service.getPendingOffer('123')).toBeNull();
  });

  it('acceptPendingOffer starts a session at default severity and clears the offer', async () => {
    (prisma.tiltSession.create as jest.Mock).mockResolvedValue({});
    (strategyRetrieval.search as jest.Mock).mockResolvedValue([]);
    service.setPendingOffer('123', 'feeding');

    const technique = await service.acceptPendingOffer('123');

    expect(technique).toBeTruthy();
    expect(prisma.tiltSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: '123', trigger: 'feeding', severity: 5 }),
    });
    // Offer is consumed.
    expect(service.getPendingOffer('123')).toBeNull();
  });

  it('acceptPendingOffer returns null when there is no pending offer', async () => {
    const technique = await service.acceptPendingOffer('nobody');
    expect(technique).toBeNull();
    expect(prisma.tiltSession.create).not.toHaveBeenCalled();
  });

  describe('respondToPendingOffer — the accept/decline state machine (moved out of the coach hot path)', () => {
    it('returns kind "none" when there is no pending offer, so coaching continues', async () => {
      const outcome = await service.respondToPendingOffer('123', 'accept');
      expect(outcome).toEqual({ kind: 'none' });
    });

    it('accepts a pending offer (any text starting with "accept") and starts the session', async () => {
      (prisma.tiltSession.create as jest.Mock).mockResolvedValue({});
      (strategyRetrieval.search as jest.Mock).mockResolvedValue([]);
      service.setPendingOffer('123', 'feeding');

      const outcome = await service.respondToPendingOffer('123', 'Accept please');

      expect(outcome.kind).toBe('accepted');
      expect((outcome as { reply: string }).reply).toContain('Reset technique');
      expect(prisma.tiltSession.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId: '123', trigger: 'feeding' }),
      });
      // Offer consumed.
      expect(service.getPendingOffer('123')).toBeNull();
    });

    it('declines a pending offer and clears it without starting a session', async () => {
      service.setPendingOffer('123', 'raging');

      const outcome = await service.respondToPendingOffer('123', 'decline');

      expect(outcome.kind).toBe('declined');
      expect((outcome as { reply: string }).reply).toBeTruthy();
      expect(prisma.tiltSession.create).not.toHaveBeenCalled();
      expect(service.getPendingOffer('123')).toBeNull();
    });

    it('returns kind "ignored" (offer left to lapse) when the reply is neither accept nor decline', async () => {
      service.setPendingOffer('123', 'feeding');

      const outcome = await service.respondToPendingOffer('123', 'idk maybe later');

      expect(outcome).toEqual({ kind: 'ignored' });
      // Not consumed — it lapses on its own TTL.
      expect(service.getPendingOffer('123')).toBe('feeding');
      expect(prisma.tiltSession.create).not.toHaveBeenCalled();
    });
  });

  describe('maybeOffer — detection-driven offer creation', () => {
    it('returns the accept-prompt and stores a pending offer when tilt language is detected', () => {
      const message = service.maybeOffer('123', 'my teammates keep feeding ugh');

      expect(message).toContain('accept');
      expect(message).toContain('decline');
      expect(service.getPendingOffer('123')).toBe('feeding');
    });

    it('returns null (no offer) when the text is not tilt language', () => {
      const message = service.maybeOffer('123', 'had a great game today');
      expect(message).toBeNull();
      expect(service.getPendingOffer('123')).toBeNull();
    });

    it('does not stack a second offer while one is already pending', () => {
      service.setPendingOffer('123', 'raging');
      const message = service.maybeOffer('123', 'teammates feeding again');
      expect(message).toBeNull();
      // The original offer is untouched.
      expect(service.getPendingOffer('123')).toBe('raging');
    });
  });

  describe('offerFromIntent — classifier-driven offer (no keyword gate)', () => {
    it('offers a session even when no tilt keyword is present (paraphrased frustration)', () => {
      // The discovery classifier said "tilt" though the keyword heuristic would miss this phrasing.
      const message = service.offerFromIntent('123', 'i just cannot catch a break out there tonight');

      expect(message).toContain('accept');
      expect(message).toContain('decline');
      expect(service.getPendingOffer('123')).toBe('frustration'); // generic trigger when no keyword
    });

    it('uses a detected keyword as the trigger when one IS present', () => {
      service.offerFromIntent('123', 'my team keeps feeding');
      expect(service.getPendingOffer('123')).toBe('feeding');
    });

    it('does not stack a second offer while one is already pending (returns null)', () => {
      service.setPendingOffer('123', 'raging');
      const message = service.offerFromIntent('123', 'still so done with this');
      expect(message).toBeNull();
      expect(service.getPendingOffer('123')).toBe('raging');
    });
  });

  it('creates an offer for detected frustration', () => {
    const offer = service.createOffer('raging');

    expect(offer.acceptMessage).toContain('accept');
    expect(offer.acceptMessage).toContain('decline');
    expect(offer.acceptMessage).toContain('raging');
    expect(offer.declineMessage).toBeTruthy();
    expect(offer.trigger).toBe('raging');
  });

  it('acceptOffer — the shared create primitive — writes a session and returns the technique', async () => {
    (prisma.tiltSession.create as jest.Mock).mockResolvedValue({});
    (strategyRetrieval.search as jest.Mock).mockResolvedValue([]);

    const technique = await service.acceptOffer('123', {
      trigger: 'frustrated',
      severity: 7,
    });

    expect(prisma.tiltSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: '123',
        trigger: 'frustrated',
        severity: 7,
      }),
    });
    expect(technique).toBeTruthy();
  });

  it('resolves active tilt sessions', async () => {
    (prisma.tiltSession.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

    await service.resolve('123');

    expect(prisma.tiltSession.updateMany).toHaveBeenCalledWith({
      where: {
        userId: '123',
        resolved: false,
      },
      data: {
        resolved: true,
      },
    });
  });

  it('auto-resolves expired sessions', async () => {
    (prisma.tiltSession.updateMany as jest.Mock).mockResolvedValue({ count: 5 });

    const count = await service.autoResolveExpired();

    expect(count).toBe(5);
    expect(prisma.tiltSession.updateMany).toHaveBeenCalledWith({
      where: {
        resolved: false,
        expiresAt: expect.any(Object),
      },
      data: {
        resolved: true,
      },
    });
  });

  it('returns tilt stats', async () => {
    (prisma.tiltSession.findMany as jest.Mock).mockResolvedValue([
      { trigger: 'tilt', severity: 7 },
      { trigger: 'frustrated', severity: 5 },
      { trigger: 'tilt', severity: 8 },
    ]);

    const stats = await service.stats('123');

    expect(stats.total).toBe(3);
    expect(stats.avgSeverity).toBeCloseTo(6.7, 1);
    expect(stats.commonTriggers[0].trigger).toBe('tilt');
  });

  // The crisis classifier reads this to disambiguate technique-frustration ("it's not helping") from
  // self-harm during a reset — a session counts as active only while unresolved AND unexpired.
  describe('hasActiveSession', () => {
    it('is true when an unresolved, unexpired session exists', async () => {
      (prisma.tiltSession.count as jest.Mock).mockResolvedValue(1);

      const active = await service.hasActiveSession('123');

      expect(active).toBe(true);
      expect(prisma.tiltSession.count).toHaveBeenCalledWith({
        where: { userId: '123', resolved: false, expiresAt: expect.any(Object) },
      });
    });

    it('is false when no session is open', async () => {
      (prisma.tiltSession.count as jest.Mock).mockResolvedValue(0);

      expect(await service.hasActiveSession('123')).toBe(false);
    });
  });

  it('returns empty stats when no sessions', async () => {
    (prisma.tiltSession.findMany as jest.Mock).mockResolvedValue([]);

    const stats = await service.stats('123');

    expect(stats).toEqual({
      total: 0,
      avgSeverity: 0,
      commonTriggers: [],
    });
  });
});
