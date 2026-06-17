import { MoodService } from '../mood.service';
import { prisma } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  prisma: {
    mood: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
  },
  ratingToEmoji: (rating: number) =>
    ({ 1: '😞', 2: '😔', 3: '😐', 4: '🙂', 5: '😊' })[rating] ?? '😐',
}));

// MoodService is now a plain persist + read service: crisis screening of the note and consent-gated
// derivation moved to InnerStateLogger (ADR-0028/0029), so the service no longer touches either seam.
describe('MoodService', () => {
  let service: MoodService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MoodService();
  });

  it('creates a mood record with a null note when none is given', async () => {
    (prisma.mood.create as jest.Mock).mockResolvedValue({});
    await service.create('123', { rating: 4, emoji: '🙂' });

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

  it('persists the free-text note verbatim when present', async () => {
    (prisma.mood.create as jest.Mock).mockResolvedValue({});
    await service.create('123', { rating: 3, emoji: '😐', note: 'feeling okay' });

    expect(prisma.mood.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ note: 'feeling okay' }),
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
