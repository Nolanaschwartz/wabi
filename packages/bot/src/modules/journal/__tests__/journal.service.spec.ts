import { JournalService } from '../journal.service';
import { ClassifierService } from '../../coaching/classifier.service';
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

jest.mock('../../coaching/classifier.service', () => ({
  ClassifierService: jest.fn().mockImplementation(() => ({
    classify: jest.fn(),
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
  let classifier: jest.Mocked<ClassifierService>;
  let coach: jest.Mocked<CoachService>;
  let xp: jest.Mocked<XpService>;

  beforeEach(() => {
    jest.clearAllMocks();
    classifier = new ClassifierService() as any;
    coach = new CoachService() as any;
    xp = new XpService() as any;
    service = new JournalService(classifier, coach, xp);
  });

  it('returns a prompt', async () => {
    const prompt = await service.prompt();
    expect(prompt.length).toBeGreaterThan(10);
  });

  it('saves entry with AI-generated reflection for safe content', async () => {
    (classifier.classify as jest.Mock).mockResolvedValue('safe');
    (coach.generate as jest.Mock).mockResolvedValue("Thanks for sharing that.");
    (prisma.journalEntry.create as jest.Mock).mockResolvedValue({});

    const result = await service.write('123', 'I had a good day today');

    expect(result.crisis).toBe(false);
    expect(result.reflection).toBeTruthy();
    expect(coach.generate).toHaveBeenCalled();
    expect(prisma.journalEntry.create).toHaveBeenCalled();
  });

  it('awards journal XP itself on a saved entry (the rule lives in the module, not the controller)', async () => {
    (classifier.classify as jest.Mock).mockResolvedValue('safe');
    (coach.generate as jest.Mock).mockResolvedValue('Nice.');
    (prisma.journalEntry.create as jest.Mock).mockResolvedValue({});

    const result = await service.write('123', 'I had a good day today');

    expect(xp.award).toHaveBeenCalledWith('123', 10, 'journal');
    expect(result.xpAwarded).toBe(10);
  });

  it('flags crisis content and does not save', async () => {
    (classifier.classify as jest.Mock).mockResolvedValue('crisis');

    const result = await service.write('123', 'I want to end it all');

    expect(result.crisis).toBe(true);
    expect(result.reflection).toBe('');
    expect(prisma.journalEntry.create).not.toHaveBeenCalled();
  });

  it('awards no XP on crisis (skips it explicitly, never persists)', async () => {
    (classifier.classify as jest.Mock).mockResolvedValue('crisis');

    const result = await service.write('123', 'I want to end it all');

    expect(xp.award).not.toHaveBeenCalled();
    expect(result.xpAwarded).toBe(0);
  });

  it('falls back to default reflection on coach error', async () => {
    (classifier.classify as jest.Mock).mockResolvedValue('safe');
    (coach.generate as jest.Mock).mockRejectedValue(new Error('API down'));
    (prisma.journalEntry.create as jest.Mock).mockResolvedValue({});

    const result = await service.write('123', 'I had a good day today');

    expect(result.crisis).toBe(false);
    expect(result.reflection).toBeTruthy();
    expect(prisma.journalEntry.create).toHaveBeenCalled();
  });
});
