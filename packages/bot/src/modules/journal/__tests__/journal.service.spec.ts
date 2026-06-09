import { JournalService } from '../journal.service';
import { CrisisScreeningService } from '../../crisis/crisis-screening.service';
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

// Mock the screening module wholesale so its transitive escalation→pg-boss imports never load.
jest.mock('../../crisis/crisis-screening.service', () => ({
  CrisisScreeningService: jest.fn().mockImplementation(() => ({
    screen: jest.fn(),
  })),
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
  let screening: jest.Mocked<CrisisScreeningService>;
  let coach: jest.Mocked<CoachService>;
  let xp: jest.Mocked<XpService>;
  const crisisPayload = { embeds: [{ title: '🚨 You matter' }] };

  beforeEach(() => {
    jest.clearAllMocks();
    screening = new CrisisScreeningService(undefined as any, undefined as any) as any;
    coach = new CoachService() as any;
    xp = new XpService() as any;
    service = new JournalService(screening, coach, xp);
  });

  it('returns a prompt', async () => {
    const prompt = await service.prompt();
    expect(prompt.length).toBeGreaterThan(10);
  });

  it('screens the entry content before persisting', async () => {
    (screening.screen as jest.Mock).mockResolvedValue({ kind: 'safe' });
    (coach.generate as jest.Mock).mockResolvedValue('Thanks for sharing that.');
    (prisma.journalEntry.create as jest.Mock).mockResolvedValue({});

    await service.write('123', 'I had a good day today');

    expect(screening.screen).toHaveBeenCalledWith('123', 'I had a good day today');
  });

  it('saves entry with AI-generated reflection for safe content', async () => {
    (screening.screen as jest.Mock).mockResolvedValue({ kind: 'safe' });
    (coach.generate as jest.Mock).mockResolvedValue('Thanks for sharing that.');
    (prisma.journalEntry.create as jest.Mock).mockResolvedValue({});

    const result = await service.write('123', 'I had a good day today');

    expect(result.crisis).toBe(false);
    if (!result.crisis) {
      expect(result.reflection).toBeTruthy();
    }
    expect(coach.generate).toHaveBeenCalled();
    expect(prisma.journalEntry.create).toHaveBeenCalled();
  });

  it('awards journal XP itself on a saved entry (the rule lives in the module, not the controller)', async () => {
    (screening.screen as jest.Mock).mockResolvedValue({ kind: 'safe' });
    (coach.generate as jest.Mock).mockResolvedValue('Nice.');
    (prisma.journalEntry.create as jest.Mock).mockResolvedValue({});

    const result = await service.write('123', 'I had a good day today');

    expect(xp.award).toHaveBeenCalledWith('123', 10, 'journal');
    expect(result.crisis).toBe(false);
    if (!result.crisis) {
      expect(result.xpAwarded).toBe(10);
    }
  });

  it('on a crisis verdict returns the real escalation payload and does not save', async () => {
    (screening.screen as jest.Mock).mockResolvedValue({
      kind: 'crisis',
      response: crisisPayload,
    });

    const result = await service.write('123', 'I want to end it all');

    expect(result.crisis).toBe(true);
    if (result.crisis) {
      // The real locale resources from escalation — not a hand-rolled platitude.
      expect(result.response).toBe(crisisPayload);
    }
    expect(prisma.journalEntry.create).not.toHaveBeenCalled();
    expect(coach.generate).not.toHaveBeenCalled();
  });

  it('awards no XP on crisis (never persists, never rewards)', async () => {
    (screening.screen as jest.Mock).mockResolvedValue({
      kind: 'crisis',
      response: crisisPayload,
    });

    await service.write('123', 'I want to end it all');

    expect(xp.award).not.toHaveBeenCalled();
  });

  it('falls back to default reflection on coach error', async () => {
    (screening.screen as jest.Mock).mockResolvedValue({ kind: 'safe' });
    (coach.generate as jest.Mock).mockRejectedValue(new Error('API down'));
    (prisma.journalEntry.create as jest.Mock).mockResolvedValue({});

    const result = await service.write('123', 'I had a good day today');

    expect(result.crisis).toBe(false);
    if (!result.crisis) {
      expect(result.reflection).toBeTruthy();
    }
    expect(prisma.journalEntry.create).toHaveBeenCalled();
  });
});
