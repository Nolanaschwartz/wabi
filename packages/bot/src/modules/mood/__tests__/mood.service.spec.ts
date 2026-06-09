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

// MoodService imports the screening class for DI; stub the module so its transitive
// escalation→pg-boss (ESM) imports never load. We inject a plain mock anyway.
jest.mock('../../crisis/crisis-screening.service', () => ({
  CrisisScreeningService: class {},
}));

describe('MoodService', () => {
  let service: MoodService;
  let screening: { guard: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: guard runs the persist and reports safe. The screen-then-escalate behaviour itself is
    // covered in crisis-screening.spec; here we only verify MoodService routes through the seam.
    screening = {
      guard: jest.fn(async (_id, _content, persist) => ({
        crisis: false,
        value: await persist(),
      })),
    };
    service = new MoodService(screening as any);
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

  it('screens the note as the free-text field before persisting (ADR-0028)', async () => {
    (prisma.mood.create as jest.Mock).mockResolvedValue({});
    await service.log('123', { rating: 3, emoji: '😐', note: 'feeling okay' });

    expect(screening.guard).toHaveBeenCalledWith('123', 'feeling okay', expect.any(Function));
    expect(prisma.mood.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ note: 'feeling okay' }),
    });
  });

  it('returns the crisis result and does not persist when the note trips screening', async () => {
    const payload = { embeds: [{ title: '🚨 You matter' }] };
    screening.guard.mockResolvedValue({ crisis: true, response: payload });

    const result = await service.log('123', {
      rating: 1,
      emoji: '😞',
      note: 'I want to die',
    });

    expect(result).toEqual({ crisis: true, response: payload });
    expect(prisma.mood.create).not.toHaveBeenCalled();
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
