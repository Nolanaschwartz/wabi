import { JournalService } from '../journal.service';
import { CoachService } from '../../coaching/coach.service';
import { XpService } from '../../xp/xp.service';
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

jest.mock('../../xp/xp.service', () => ({
  XpService: jest.fn().mockImplementation(() => ({
    award: jest.fn(),
  })),
}));

describe('JournalService', () => {
  let service: JournalService;
  let screening: { guard: jest.Mock };
  let coach: jest.Mocked<CoachService>;
  let xp: jest.Mocked<XpService>;
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
    xp = new XpService() as any;
    service = new JournalService(screening as any, coach, xp);
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

  it('awards journal XP itself on a saved entry (the rule lives in the module, not the controller)', async () => {
    (coach.generate as jest.Mock).mockResolvedValue('Nice.');
    (prisma.journalEntry.create as jest.Mock).mockResolvedValue({});

    const result = await service.write('123', 'I had a good day today');

    expect(xp.award).toHaveBeenCalledWith('123', 10, 'journal');
    expect(result.crisis).toBe(false);
    if (!result.crisis) {
      expect(result.value.xpAwarded).toBe(10);
    }
  });

  it('on a crisis verdict returns the real escalation payload and does not save', async () => {
    screening.guard.mockResolvedValue({ crisis: true, response: crisisPayload });

    const result = await service.write('123', 'I want to end it all');

    expect(result.crisis).toBe(true);
    if (result.crisis) {
      expect(result.response).toBe(crisisPayload);
    }
    expect(prisma.journalEntry.create).not.toHaveBeenCalled();
    expect(coach.generate).not.toHaveBeenCalled();
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
