import { JournalService } from '../journal.service';
import { ClassifierService } from '../../coaching/classifier.service';
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

describe('JournalService', () => {
  let service: JournalService;
  let classifier: jest.Mocked<ClassifierService>;

  beforeEach(() => {
    jest.clearAllMocks();
    classifier = new ClassifierService() as any;
    service = new JournalService(classifier);
  });

  it('returns a prompt', async () => {
    const prompt = await service.prompt();
    expect(prompt.length).toBeGreaterThan(10);
  });

  it('saves entry with reflection for safe content', async () => {
    (classifier.classify as jest.Mock).mockResolvedValue('safe');
    (prisma.journalEntry.create as jest.Mock).mockResolvedValue({});

    const result = await service.write('123', 'I had a good day today');

    expect(result.crisis).toBe(false);
    expect(result.reflection).toBeTruthy();
    expect(prisma.journalEntry.create).toHaveBeenCalled();
  });

  it('flags crisis content and does not save', async () => {
    (classifier.classify as jest.Mock).mockResolvedValue('crisis');

    const result = await service.write('123', 'I want to end it all');

    expect(result.crisis).toBe(true);
    expect(result.reflection).toBe('');
    expect(prisma.journalEntry.create).not.toHaveBeenCalled();
  });

  it('generates positive reflection for happy content', async () => {
    (classifier.classify as jest.Mock).mockResolvedValue('safe');
    (prisma.journalEntry.create as jest.Mock).mockResolvedValue({});

    const result = await service.write('123', 'I feel great today');

    expect(result.reflection).toContain('positive');
  });

  it('generates supportive reflection for difficult content', async () => {
    (classifier.classify as jest.Mock).mockResolvedValue('safe');
    (prisma.journalEntry.create as jest.Mock).mockResolvedValue({});

    const result = await service.write('123', 'This is really hard');

    expect(result.reflection).toContain('courage');
  });

  it('generates short reflection for brief content', async () => {
    (classifier.classify as jest.Mock).mockResolvedValue('safe');
    (prisma.journalEntry.create as jest.Mock).mockResolvedValue({});

    const result = await service.write('123', 'Okay today');

    expect(result.reflection).toContain('small note');
  });
});
