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

describe('TiltService', () => {
  let service: TiltService;
  let strategyRetrieval: jest.Mocked<StrategyRetrievalService>;

  beforeEach(() => {
    jest.clearAllMocks();
    strategyRetrieval = new StrategyRetrievalService() as any;
    service = new TiltService(strategyRetrieval);
  });

  it('detects tilt language', () => {
    expect(service.isTiltLanguage("I'm so frustrated")).toBe(true);
    expect(service.isTiltLanguage('tilt is real')).toBe(true);
    expect(service.isTiltLanguage('good game')).toBe(false);
  });

  it('starts a tilt session', async () => {
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
    (prisma.tiltSession.updateMany as jest.Mock).mockResolvedValue({});

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
