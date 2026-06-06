import { PlaytimeService } from '../playtime.service';
import { prisma } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  prisma: {
    playtimeLog: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
  },
}));

describe('PlaytimeService', () => {
  let service: PlaytimeService;

  beforeEach(() => {
    service = new PlaytimeService();
    jest.clearAllMocks();
  });

  it('logs a playtime record', async () => {
    (prisma.playtimeLog.create as jest.Mock).mockResolvedValue({});
    await service.log('123', { duration: 60, game: 'LoL' });

    expect(prisma.playtimeLog.create).toHaveBeenCalledWith({
      data: {
        userId: '123',
        duration: 60,
        game: 'LoL',
      },
    });
  });

  it('logs playtime without game', async () => {
    (prisma.playtimeLog.create as jest.Mock).mockResolvedValue({});
    await service.log('123', { duration: 30 });

    expect(prisma.playtimeLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        game: null,
      }),
    });
  });

  it('returns healthy stats', async () => {
    (prisma.playtimeLog.findMany as jest.Mock).mockResolvedValue([
      { duration: 60 },
      { duration: 90 },
    ]);

    const stats = await service.stats('123', 7);
    expect(stats.status).toBe('healthy');
    expect(stats.total).toBe(150);
  });

  it('returns over status for high daily avg', async () => {
    (prisma.playtimeLog.findMany as jest.Mock).mockResolvedValue([
      { duration: 180 },
      { duration: 180 },
      { duration: 180 },
      { duration: 180 },
      { duration: 180 },
    ]);

    const stats = await service.stats('123', 7);
    expect(stats.status).toBe('over');
  });

  it('returns zero stats when no logs', async () => {
    (prisma.playtimeLog.findMany as jest.Mock).mockResolvedValue([]);
    const stats = await service.stats('123', 7);

    expect(stats).toEqual({
      total: 0,
      dailyAvg: 0,
      status: 'healthy',
    });
  });

  it('identifies long sessions', () => {
    expect(PlaytimeService.isLongSession(60)).toBe(false);
    expect(PlaytimeService.isLongSession(120)).toBe(true);
    expect(PlaytimeService.isLongSession(240)).toBe(true);
  });

  it('generates gentle heads-up', () => {
    const msg = PlaytimeService.gentleHeadsUp(150);
    expect(msg).toContain('2h 30m');
    expect(msg).toContain('breaks');
  });
});
