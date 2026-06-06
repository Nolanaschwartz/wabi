import { CoachingService } from '../coaching.service';
import { ClassifierService } from '../classifier.service';
import { CoachService } from '../coach.service';
import { prisma } from '@wabi/shared';
import { SessionBufferService } from '../../session-buffer/session-buffer.service';
import { StrategyRetrievalService } from '../../strategy-retrieval/strategy-retrieval.service';
import { BurstCoalescer } from '../../burst-coalescer/burst-coalescer.service';
import { LangfuseTracer } from '../../langfuse/langfuse-tracer.service';
import { AccessResolver } from '../../billing/access-resolver';
import { MemoryStoreService } from '../../memory/memory-store.service';

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

jest.mock('../../burst-coalescer/burst-coalescer.service', () => ({
  BurstCoalescer: jest.fn().mockImplementation(() => ({
    coalesce: jest.fn(),
    cancel: jest.fn(),
    addMessage: jest.fn(),
  })),
}));

jest.mock('../../langfuse/langfuse-tracer.service', () => ({
  LangfuseTracer: jest.fn().mockImplementation(() => ({
    trace: jest.fn(),
    score: jest.fn(),
  })),
}));

jest.mock('../../billing/access-resolver', () => ({
  AccessResolver: jest.fn().mockImplementation(() => ({
    resolve: jest.fn(),
  })),
}));

jest.mock('../../memory/memory-store.service', () => ({
  MemoryStoreService: jest.fn().mockImplementation(() => ({
    deriveAndStore: jest.fn(),
  })),
}));

describe('CoachingService', () => {
  let service: CoachingService;
  let classifier: jest.Mocked<ClassifierService>;
  let coach: jest.Mocked<CoachService>;
  let sessionBuffer: jest.Mocked<SessionBufferService>;
  let strategyRetrieval: jest.Mocked<StrategyRetrievalService>;
  let burstCoalescer: jest.Mocked<BurstCoalescer>;
  let langfuseTracer: jest.Mocked<LangfuseTracer>;
  let accessResolver: jest.Mocked<AccessResolver>;
  let memoryStore: jest.Mocked<MemoryStoreService>;

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
    burstCoalescer = new BurstCoalescer() as any;
    langfuseTracer = new LangfuseTracer() as any;
    accessResolver = new AccessResolver() as any;
    memoryStore = new MemoryStoreService() as any;
    service = new CoachingService(
      classifier,
      coach,
      sessionBuffer,
      strategyRetrieval,
      burstCoalescer,
      langfuseTracer,
      accessResolver,
      memoryStore,
    );
  });

  it('shows setup link for unconsented user', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: null,
    });

    await service.handle(mockMessage, jest.fn());

    expect(mockMessage.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('finish setup'),
      }),
    );
    expect(burstCoalescer.coalesce).not.toHaveBeenCalled();
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it('shows subscribe link for lapsed access (before any classifier work)', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: new Date(),
    });
    (accessResolver.resolve as jest.Mock).mockResolvedValue({
      hasActiveAccess: false,
      subscriptionStatus: 'past_due',
    });

    await service.handle(mockMessage, jest.fn());

    expect(classifier.classify).not.toHaveBeenCalled();
    expect(mockMessage.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Subscribe'),
      }),
    );
    expect(coach.generate).not.toHaveBeenCalled();
  });

  it('escalates on classifier crisis and quarantines session', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: new Date(),
    });
    (accessResolver.resolve as jest.Mock).mockResolvedValue({
      hasActiveAccess: true,
      subscriptionStatus: 'trialing',
    });
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue('batch');
    classifier.classify.mockResolvedValue('crisis');
    strategyRetrieval.search.mockResolvedValue([]);

    const onCrisis = jest.fn();
    await service.handle(mockMessage, onCrisis);

    expect(onCrisis).toHaveBeenCalled();
    expect(sessionBuffer.clearAndQuarantine).toHaveBeenCalledWith('123');
    expect(coach.generate).not.toHaveBeenCalled();
    expect(burstCoalescer.cancel).toHaveBeenCalled();
    expect(langfuseTracer.trace).toHaveBeenCalledWith(
      expect.any(String),
      'classify',
      'batch',
      'crisis',
      { isCrisis: true },
    );
  });

  it('coaches on safe classification with active access', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: new Date(),
    });
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue('test message');
    classifier.classify.mockResolvedValue('safe');
    (accessResolver.resolve as jest.Mock).mockResolvedValue({
      hasActiveAccess: true,
      subscriptionStatus: 'trialing',
    });
    strategyRetrieval.search.mockResolvedValue([]);
    sessionBuffer.getContext.mockResolvedValue(null);
    coach.generate.mockResolvedValue("That sounds tough. Hang in there.");

    await service.handle(mockMessage, jest.fn());

    expect(coach.generate).toHaveBeenCalled();
    expect(strategyRetrieval.search).toHaveBeenCalled();
    expect(sessionBuffer.append).toHaveBeenCalled();
    expect(mockMessage.reply).toHaveBeenCalledWith("That sounds tough. Hang in there.");
  });

  it('cancels pending coach turn on crisis', async () => {
    service.cancelPending('123');
    expect(burstCoalescer.cancel).toHaveBeenCalledWith('123');
  });

  it('classifier and retrieval run concurrently (pipeline order)', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: new Date(),
    });
    (accessResolver.resolve as jest.Mock).mockResolvedValue({
      hasActiveAccess: true,
      subscriptionStatus: 'trialing',
    });
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue('test message');
    classifier.classify.mockResolvedValue('safe');
    strategyRetrieval.search.mockResolvedValue([]);
    sessionBuffer.getContext.mockResolvedValue(null);
    coach.generate.mockResolvedValue("That sounds tough. Hang in there.");

    await service.handle(mockMessage, jest.fn());

    expect(classifier.classify).toHaveBeenCalledWith('test message');
    expect(strategyRetrieval.search).toHaveBeenCalledWith('test message');
    expect(coach.generate).toHaveBeenCalled();
    expect(memoryStore.deriveAndStore).toHaveBeenCalledWith(
      '123',
      expect.stringContaining('test message'),
    );
  });

  it('skips interim messages when coalesce returns null', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: new Date(),
    });
    (accessResolver.resolve as jest.Mock).mockResolvedValue({
      hasActiveAccess: true,
      subscriptionStatus: 'trialing',
    });
    (burstCoalescer.coalesce as jest.Mock).mockReturnValue(null);

    await service.handle(mockMessage, jest.fn());

    expect(classifier.classify).not.toHaveBeenCalled();
    expect(coach.generate).not.toHaveBeenCalled();
  });

  it('coaches even when retrieval fails (graceful degradation)', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: new Date(),
    });
    (accessResolver.resolve as jest.Mock).mockResolvedValue({
      hasActiveAccess: true,
      subscriptionStatus: 'trialing',
    });
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue('test message');
    classifier.classify.mockResolvedValue('safe');
    strategyRetrieval.search.mockRejectedValue(new Error('qdrant down'));
    sessionBuffer.getContext.mockResolvedValue(null);
    coach.generate.mockResolvedValue("That sounds tough. Hang in there.");

    await service.handle(mockMessage, jest.fn());

    expect(coach.generate).toHaveBeenCalled();
    expect(mockMessage.reply).toHaveBeenCalledWith("That sounds tough. Hang in there.");
  });
});
