import { JournalService } from '../journal.service';
import { CoachService } from '../../coaching/coach.service';
import { HabitEngagementService } from '../../habit-engagement/habit-engagement.service';
import { prisma } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  prisma: {
    journalEntry: {
      create: jest.fn(),
    },
  },
}));

// JournalService imports the screening class for DI; stub the module so its transitive
// escalation→pg-boss (ESM) imports never load. We inject a plain mock anyway.
jest.mock('../../crisis/crisis-screening.service', () => ({
  CrisisScreeningService: class {},
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

describe('JournalService', () => {
  let service: JournalService;
  let screening: { guard: jest.Mock };
  let coach: jest.Mocked<CoachService>;
  let habitEngagement: jest.Mocked<HabitEngagementService>;
  let innerStateMemory: { deriveIfConsented: jest.Mock };
  const crisisPayload = { embeds: [{ title: '🚨 You matter' }] };

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: guard runs the persist and reports safe (screening behaviour tested separately).
    screening = {
      guard: jest.fn(async (_id, _content, persist) => ({
        crisis: false,
        value: await persist(),
      })),
    };
    coach = new CoachService() as any;
    habitEngagement = new HabitEngagementService(undefined as any, undefined as any) as any;
    innerStateMemory = { deriveIfConsented: jest.fn().mockResolvedValue(undefined) };
    service = new JournalService(
      screening as any,
      coach,
      habitEngagement,
      innerStateMemory as any,
    );
  });

  it('returns a prompt', async () => {
    const prompt = await service.prompt();
    expect(prompt.length).toBeGreaterThan(10);
  });

  it('screens the entry content as the free-text field before persisting (ADR-0028)', async () => {
    (coach.generate as jest.Mock).mockResolvedValue('Thanks for sharing that.');
    (prisma.journalEntry.create as jest.Mock).mockResolvedValue({});

    await service.write('123', 'I had a good day today');

    expect(screening.guard).toHaveBeenCalledWith(
      '123',
      'I had a good day today',
      expect.any(Function),
    );
  });

  it('saves entry with AI-generated reflection for safe content', async () => {
    (coach.generate as jest.Mock).mockResolvedValue('Thanks for sharing that.');
    (prisma.journalEntry.create as jest.Mock).mockResolvedValue({});

    const result = await service.write('123', 'I had a good day today');

    expect(result.crisis).toBe(false);
    if (!result.crisis) {
      expect(result.value.reflection).toBeTruthy();
    }
    expect(coach.generate).toHaveBeenCalled();
    expect(prisma.journalEntry.create).toHaveBeenCalled();
  });

  it('logs a journal Engagement through the single writer on a saved entry (ADR-0027)', async () => {
    (coach.generate as jest.Mock).mockResolvedValue('Nice.');
    (prisma.journalEntry.create as jest.Mock).mockResolvedValue({});

    const result = await service.write('123', 'I had a good day today');

    expect(habitEngagement.record).toHaveBeenCalledWith('123', 'journal');
    expect(result.crisis).toBe(false);
    if (!result.crisis) {
      expect(result.value.xpAwarded).toBe(10);
    }
  });

  it('derives Memory through the screened path for a safe entry (ADR-0029)', async () => {
    (coach.generate as jest.Mock).mockResolvedValue('Thanks for sharing that.');
    (prisma.journalEntry.create as jest.Mock).mockResolvedValue({});

    await service.write('123', 'I had a good day today');

    // The content is handed to the consent-gated inner-state module prefixed with its source word,
    // and carries no metric — the module decides whether it actually becomes Memory.
    expect(innerStateMemory.deriveIfConsented).toHaveBeenCalledWith(
      '123',
      'Journal: I had a good day today',
    );
  });

  it('on a crisis verdict returns the real escalation payload and neither saves nor derives', async () => {
    screening.guard.mockResolvedValue({ crisis: true, response: crisisPayload });

    const result = await service.write('123', 'I want to end it all');

    expect(result.crisis).toBe(true);
    if (result.crisis) {
      expect(result.response).toBe(crisisPayload);
    }
    expect(prisma.journalEntry.create).not.toHaveBeenCalled();
    expect(coach.generate).not.toHaveBeenCalled();
    // Crisis text physically cannot reach derived Memory — derivation rides inside guard()'s
    // success closure, which never runs on a crisis verdict (ADR-0029).
    expect(innerStateMemory.deriveIfConsented).not.toHaveBeenCalled();
  });

  it('falls back to default reflection on coach error', async () => {
    (coach.generate as jest.Mock).mockRejectedValue(new Error('API down'));
    (prisma.journalEntry.create as jest.Mock).mockResolvedValue({});

    const result = await service.write('123', 'I had a good day today');

    expect(result.crisis).toBe(false);
    if (!result.crisis) {
      expect(result.value.reflection).toBeTruthy();
    }
    expect(prisma.journalEntry.create).toHaveBeenCalled();
  });
});
