import { JournalService } from '../journal.service';
import { CoachService } from '../../coaching/coach.service';
import { HabitEngagementService } from '../../habit-engagement/habit-engagement.service';
import { prisma } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  prisma: {
    journalEntry: {
      create: jest.fn(),
      findFirst: jest.fn(),
    },
  },
}));

jest.mock('../../coaching/coach.service', () => ({
  CoachService: jest.fn().mockImplementation(() => ({
    generate: jest.fn(),
  })),
}));

jest.mock('../../habit-engagement/habit-engagement.service', () => ({
  HabitEngagementService: jest.fn().mockImplementation(() => ({
    record: jest.fn().mockResolvedValue({ streak: 1, message: '', xpAwarded: 10 }),
  })),
}));

// JournalService is now a plain persist service: crisis screening of the entry and consent-gated
// derivation moved to InnerStateLogger (ADR-0028/0029). `write` returns the reflection + XP directly
// (no ScreenedRecord), so the controller reads the value without a cast.
describe('JournalService', () => {
  let service: JournalService;
  let coach: jest.Mocked<CoachService>;
  let habitEngagement: jest.Mocked<HabitEngagementService>;

  beforeEach(() => {
    jest.clearAllMocks();
    coach = new CoachService() as any;
    habitEngagement = new HabitEngagementService(undefined as any, undefined as any) as any;
    service = new JournalService(coach, habitEngagement);
  });

  it('returns a prompt', async () => {
    const prompt = await service.prompt();
    expect(prompt.length).toBeGreaterThan(10);
  });

  it('saves the entry with an AI-generated reflection and returns it', async () => {
    (coach.generate as jest.Mock).mockResolvedValue('Thanks for sharing that.');
    (prisma.journalEntry.create as jest.Mock).mockResolvedValue({});

    const result = await service.write('123', 'I had a good day today');

    expect(result.reflection).toBe('Thanks for sharing that.');
    expect(coach.generate).toHaveBeenCalled();
    expect(prisma.journalEntry.create).toHaveBeenCalled();
  });

  it('logs a journal Engagement through the single writer and returns the awarded XP (ADR-0027)', async () => {
    (coach.generate as jest.Mock).mockResolvedValue('Nice.');
    (prisma.journalEntry.create as jest.Mock).mockResolvedValue({});

    const result = await service.write('123', 'I had a good day today');

    expect(habitEngagement.record).toHaveBeenCalledWith('123', 'journal');
    expect(result.xpAwarded).toBe(10);
  });

  it('latestEntry returns the most recent entry for the user (read-only, newest first)', async () => {
    const entry = { content: 'rough ranked night', reflection: 'glad you wrote it', createdAt: new Date('2026-06-13T20:00:00Z') };
    (prisma.journalEntry.findFirst as jest.Mock).mockResolvedValue(entry);

    const result = await service.latestEntry('123');

    expect(result).toEqual(entry);
    expect(prisma.journalEntry.findFirst).toHaveBeenCalledWith({
      where: { userId: '123' },
      orderBy: { createdAt: 'desc' },
    });
    // A pure read — never writes or records engagement.
    expect(prisma.journalEntry.create).not.toHaveBeenCalled();
  });

  it('latestEntry returns null when the user has no entries', async () => {
    (prisma.journalEntry.findFirst as jest.Mock).mockResolvedValue(null);

    expect(await service.latestEntry('123')).toBeNull();
  });

  it('falls back to a default reflection on coach error', async () => {
    (coach.generate as jest.Mock).mockRejectedValue(new Error('API down'));
    (prisma.journalEntry.create as jest.Mock).mockResolvedValue({});

    const result = await service.write('123', 'I had a good day today');

    expect(result.reflection).toBeTruthy();
    expect(prisma.journalEntry.create).toHaveBeenCalled();
  });
});
