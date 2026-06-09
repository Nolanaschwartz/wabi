import { TiltService } from '../tilt.service';
import { StrategyRetrievalService } from '../../strategy-retrieval/strategy-retrieval.service';
import { prisma } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  prisma: {
    tiltSession: {
      create: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
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

  it('creates an offer for detected frustration', () => {
    const offer = service.createOffer('raging');

    expect(offer.acceptMessage).toContain('accept');
    expect(offer.acceptMessage).toContain('decline');
    expect(offer.acceptMessage).toContain('raging');
    expect(offer.declineMessage).toBeTruthy();
    expect(offer.trigger).toBe('raging');
  });

  it('accepting offer starts a tilt session', async () => {
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

  it('starts a tilt session (backward compat)', async () => {
    (prisma.tiltSession.create as jest.Mock).mockResolvedValue({});
    (strategyRetrieval.search as jest.Mock).mockResolvedValue([]);

    const technique = await service.start('123', {
      trigger: 'tilt',
      severity: 7,
    });

    expect(prisma.tiltSession.create).toHaveBeenCalled();
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
