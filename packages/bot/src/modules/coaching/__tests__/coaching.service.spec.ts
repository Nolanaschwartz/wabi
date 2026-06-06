import { CoachingService } from '../coaching.service';
import { ClassifierService } from '../classifier.service';
import { CoachService } from '../coach.service';
import { prisma } from '@wabi/shared';

jest.mock('@wabi/shared', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
    },
    escalationEvent: {
      create: jest.fn(),
    },
  },
}));

jest.mock('../classifier.service', () => ({
  ClassifierService: jest.fn().mockImplementation(() => ({
    classify: jest.fn(),
  })),
}));

jest.mock('../coach.service', () => ({
  CoachService: jest.fn().mockImplementation(() => ({
    generate: jest.fn(),
  })),
}));

jest.mock('../message-splitter', () => ({
  splitMessage: jest.fn((text) => [text]),
}));

describe('CoachingService', () => {
  let service: CoachingService;
  let classifier: jest.Mocked<ClassifierService>;
  let coach: jest.Mocked<CoachService>;

  const mockMessage = {
    author: { id: '123', bot: false },
    channel: {
      isDMBased: () => true,
    },
    content: 'test message',
    reply: jest.fn().mockResolvedValue({}),
  } as any;

  const crisisEmbed = { embeds: [{ title: '🚨 You matter' }] };

  beforeEach(() => {
    jest.clearAllMocks();
    classifier = new ClassifierService() as any;
    coach = new CoachService() as any;
    service = new CoachingService(classifier, coach);
  });

  it('shows setup link for unknown user', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

    await service.handle(mockMessage, jest.fn());

    expect(mockMessage.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('finish setup'),
      }),
    );
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it('shows setup link for unconsented user', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: null,
      hasActiveAccess: true,
    });

    await service.handle(mockMessage, jest.fn());

    expect(mockMessage.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('finish setup'),
      }),
    );
  });

  it('shows subscribe link for lapsed access', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: new Date(),
      hasActiveAccess: false,
    });

    await service.handle(mockMessage, jest.fn());

    expect(mockMessage.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Subscribe'),
      }),
    );
  });

  it('escalates on classifier crisis', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: new Date(),
      hasActiveAccess: true,
    });
    classifier.classify.mockResolvedValue('crisis');

    const onCrisis = jest.fn();
    await service.handle(mockMessage, onCrisis);

    expect(onCrisis).toHaveBeenCalled();
    expect(coach.generate).not.toHaveBeenCalled();
  });

  it('coaches on safe classification', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: new Date(),
      hasActiveAccess: true,
    });
    classifier.classify.mockResolvedValue('safe');
    coach.generate.mockResolvedValue('That sounds tough. Hang in there.');

    await service.handle(mockMessage, jest.fn());

    expect(coach.generate).toHaveBeenCalledWith('test message');
    expect(mockMessage.reply).toHaveBeenCalledWith('That sounds tough. Hang in there.');
  });

  it('falls back on empty coach reply', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: new Date(),
      hasActiveAccess: true,
    });
    classifier.classify.mockResolvedValue('safe');
    coach.generate.mockResolvedValue('');

    await service.handle(mockMessage, jest.fn());

    expect(mockMessage.reply).toHaveBeenCalledWith(
      expect.stringContaining("not sure how to respond"),
    );
  });
});
