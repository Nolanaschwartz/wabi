import { CoachingService } from '../coaching.service';
import { ClassifierService } from '../classifier.service';
import { CoachService } from '../coach.service';
import { prisma } from '@wabi/shared';
import { SessionBufferService } from '../../session-buffer/session-buffer.service';
import { StrategyRetrievalService } from '../../strategy-retrieval/strategy-retrieval.service';

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

jest.mock('../../session-buffer/session-buffer.service', () => ({
  SessionBufferService: jest.fn().mockImplementation(() => ({
    append: jest.fn(),
    getContext: jest.fn(),
    clearAndQuarantine: jest.fn(),
  })),
}));

jest.mock('../../strategy-retrieval/strategy-retrieval.service', () => ({
  StrategyRetrievalService: jest.fn().mockImplementation(() => ({
    search: jest.fn(),
  })),
}));

describe('CoachingService', () => {
  let service: CoachingService;
  let classifier: jest.Mocked<ClassifierService>;
  let coach: jest.Mocked<CoachService>;
  let sessionBuffer: jest.Mocked<SessionBufferService>;
  let strategyRetrieval: jest.Mocked<StrategyRetrievalService>;

  const mockMessage = {
    author: { id: '123', bot: false },
    channel: {
      isDMBased: () => true,
    },
    content: 'test message',
    reply: jest.fn().mockResolvedValue({}),
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    classifier = new ClassifierService() as any;
    coach = new CoachService() as any;
    sessionBuffer = new SessionBufferService() as any;
    strategyRetrieval = new StrategyRetrievalService() as any;
    service = new CoachingService(classifier, coach, sessionBuffer, strategyRetrieval);
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

  it('escalates on classifier crisis and quarantines session', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: new Date(),
      hasActiveAccess: true,
    });
    classifier.classify.mockResolvedValue('crisis');

    const onCrisis = jest.fn();
    await service.handle(mockMessage, onCrisis);

    expect(onCrisis).toHaveBeenCalled();
    expect(sessionBuffer.clearAndQuarantine).toHaveBeenCalledWith('123');
    expect(coach.generate).not.toHaveBeenCalled();
  });

  it('coaches on safe classification with strategy context', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: new Date(),
      hasActiveAccess: true,
    });
    classifier.classify.mockResolvedValue('safe');
    strategyRetrieval.search.mockResolvedValue([]);
    sessionBuffer.getContext.mockResolvedValue(null);
    coach.generate.mockResolvedValue("That sounds tough. Hang in there.");

    await service.handle(mockMessage, jest.fn());

    expect(coach.generate).toHaveBeenCalled();
    expect(strategyRetrieval.search).toHaveBeenCalledWith('test message');
    expect(sessionBuffer.append).toHaveBeenCalled();
    expect(mockMessage.reply).toHaveBeenCalledWith("That sounds tough. Hang in there.");
  });

  it('falls back on empty coach reply', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: new Date(),
      hasActiveAccess: true,
    });
    classifier.classify.mockResolvedValue('safe');
    strategyRetrieval.search.mockResolvedValue([]);
    sessionBuffer.getContext.mockResolvedValue(null);
    coach.generate.mockResolvedValue('');

    await service.handle(mockMessage, jest.fn());

    expect(mockMessage.reply).toHaveBeenCalledWith(
      expect.stringContaining('not sure how to respond'),
    );
  });
});
