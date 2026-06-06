import { JournalService } from '../journal.service';
import { ClassifierService } from '../../coaching/classifier.service';
import { CoachService } from '../../coaching/coach.service';
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

describe('JournalService', () => {
  let service: JournalService;
  let classifier: jest.Mocked<ClassifierService>;
  let coach: jest.Mocked<CoachService>;

  beforeEach(() => {
    jest.clearAllMocks();
    classifier = new ClassifierService() as any;
    coach = new CoachService() as any;
    service = new JournalService(classifier, coach);
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

  it('flags crisis content and does not save', async () => {
    (classifier.classify as jest.Mock).mockResolvedValue('crisis');

    const result = await service.write('123', 'I want to end it all');

    expect(result.crisis).toBe(true);
    expect(result.reflection).toBe('');
    expect(prisma.journalEntry.create).not.toHaveBeenCalled();
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
