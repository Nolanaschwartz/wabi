import { MoodService } from '../mood.service';
import { prisma } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  prisma: {
    mood: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
  },
}));

describe('MoodService', () => {
  let service: MoodService;

  beforeEach(() => {
    service = new MoodService();
    jest.clearAllMocks();
  });

  it('logs a mood record', async () => {
    (prisma.mood.create as jest.Mock).mockResolvedValue({});
    await service.log('123', { rating: 4, emoji: '🙂' });

    expect(prisma.mood.create).toHaveBeenCalledWith({
      data: {
        userId: '123',
        rating: 4,
        emoji: '🙂',
        note: null,
        context: null,
      },
    });
  });

  it('logs a mood with note', async () => {
    (prisma.mood.create as jest.Mock).mockResolvedValue({});
    await service.log('123', { rating: 3, emoji: '😐', note: 'feeling okay' });

    expect(prisma.mood.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        note: 'feeling okay',
      }),
    });
  });

  it('returns rolling average trend', async () => {
    (prisma.mood.findMany as jest.Mock).mockResolvedValue([
      { rating: 4 },
      { rating: 3 },
      { rating: 5 },
    ]);

    const trend = await service.trend('123', 7);
    expect(trend).toBeCloseTo(4, 1);
  });

  it('returns 0 trend when no moods', async () => {
    (prisma.mood.findMany as jest.Mock).mockResolvedValue([]);
    const trend = await service.trend('123', 7);
    expect(trend).toBe(0);
  });

  it('maps rating to emoji', () => {
    expect(MoodService.ratingToEmoji(1)).toBe('😞');
    expect(MoodService.ratingToEmoji(5)).toBe('😊');
    expect(MoodService.ratingToEmoji(99)).toBe('😐');
  });

  it('identifies low mood', () => {
    expect(MoodService.isLowMood(1)).toBe(true);
    expect(MoodService.isLowMood(2)).toBe(true);
    expect(MoodService.isLowMood(3)).toBe(false);
  });
});
