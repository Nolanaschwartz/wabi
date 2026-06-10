import { CoachingService } from '../coaching.service';
import { ClassifierService } from '../../crisis/classifier.service';
import { CoachService } from '../coach.service';
import { prisma } from '@wabi/shared';
import { SessionBufferService } from '../../session-buffer/session-buffer.service';
import { CoachingSessionService } from '../../session-buffer/coaching-session.service';
import { StrategyRetrievalService } from '../../strategy-retrieval/strategy-retrieval.service';
import { BurstCoalescer } from '../../burst-coalescer/burst-coalescer.service';
import { LangfuseTracer } from '../../langfuse/langfuse-tracer.service';
import { AccessResolver } from '../../billing/access-resolver';
import { MemoryStoreService } from '../../memory/memory-store.service';
import { CrisisAftermathService } from '../../crisis-aftermath/crisis-aftermath.service';
import { HabitEngagementService } from '../../habit-engagement/habit-engagement.service';
import { TiltService } from '../../tilt/tilt.service';
import { UserService } from '../../user/user.service';

jest.mock('@wabi/shared', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
    },
    escalationEvent: {
      create: jest.fn(),
    },
    xpEntry: {
      create: jest.fn(),
    },
  },
}));

jest.mock('../../crisis/classifier.service', () => ({
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

jest.mock('../../user/user.service', () => ({
  UserService: jest.fn().mockImplementation(() => ({
    findByDiscordId: jest.fn(),
  })),
}));

jest.mock('../../memory/memory-store.service', () => ({
  MemoryStoreService: jest.fn().mockImplementation(() => ({
    deriveAndStore: jest.fn(),
    search: jest.fn().mockResolvedValue([]),
  })),
}));

jest.mock('../../session-buffer/coaching-session.service', () => ({
  CoachingSessionService: jest.fn().mockImplementation(() => ({
    touch: jest.fn(),
    quarantine: jest.fn(),
  })),
}));

jest.mock('../../crisis-aftermath/crisis-aftermath.service', () => ({
  CrisisAftermathService: jest.fn(() => ({
    onEscalation: jest.fn(),
    isQuarantined: jest.fn().mockResolvedValue(false),
  })),
}));

jest.mock('../../habit-engagement/habit-engagement.service', () => ({
  HabitEngagementService: jest.fn(() => ({
    record: jest.fn().mockResolvedValue({ streak: 1, message: '', xpAwarded: 10 }),
  })),
}));

jest.mock('../../tilt/tilt.service', () => ({
  TiltService: jest.fn(() => ({
    // The offer lifecycle now lives behind two methods on TiltService (#J deepening).
    respondToPendingOffer: jest.fn().mockResolvedValue({ kind: 'none' }),
    maybeOffer: jest.fn().mockReturnValue(null),
  })),
}));

jest.mock('../../user/user.service', () => ({
  UserService: jest.fn().mockImplementation(() => ({
    findByDiscordId: jest.fn(),
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
  let coachingSession: jest.Mocked<CoachingSessionService>;
  let memoryStore: jest.Mocked<MemoryStoreService>;
  let crisisAftermath: jest.Mocked<CrisisAftermathService>;
  let escalation: { escalate: jest.Mock };
  let habitEngagement: jest.Mocked<HabitEngagementService>;
  let tilt: jest.Mocked<TiltService>;
  let userService: jest.Mocked<UserService>;

  const mockMessage = {
    author: { id: '123', bot: false },
    channel: {
      isDMBased: () => true,
    },
    content: 'test message',
    reply: jest.fn().mockResolvedValue({}),
  } as any;

  // Escalation now returns a renderable payload (no transport coupling); the DM path renders it.
  const crisisPayload = { embeds: [{ title: '🚨 You matter' }] };

  beforeEach(() => {
    jest.clearAllMocks();
    classifier = new ClassifierService() as any;
    coach = new CoachService() as any;
    sessionBuffer = new SessionBufferService() as any;
    strategyRetrieval = new StrategyRetrievalService() as any;
    burstCoalescer = new BurstCoalescer() as any;
    langfuseTracer = new LangfuseTracer() as any;
    accessResolver = new AccessResolver(new UserService()) as any;
    coachingSession = new CoachingSessionService() as any;
    memoryStore = new MemoryStoreService() as any;
    crisisAftermath = (CrisisAftermathService as jest.Mock)() as any;
    escalation = { escalate: jest.fn().mockResolvedValue(crisisPayload) };
    habitEngagement = (HabitEngagementService as jest.Mock)() as any;
    tilt = (TiltService as jest.Mock)() as any;
    userService = new UserService() as any;
    service = new CoachingService(
      classifier,
      coach,
      sessionBuffer,
      coachingSession,
      strategyRetrieval,
      burstCoalescer,
      langfuseTracer,
      accessResolver,
      memoryStore,
      crisisAftermath,
      escalation as any,
      habitEngagement,
      tilt,
      userService,
    );
  });

  it('shows setup link pointing at the real onboarding route for unconsented user', async () => {
    process.env.NEXT_PUBLIC_BASE_URL = 'https://wabi.gg';
    (userService.findByDiscordId as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: null,
      timezone: 'UTC',
    });

    await service.handle(mockMessage);

    expect(mockMessage.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        // Real OAuth entry, not the old dead /onboard link (issue #28).
        content: expect.stringContaining('https://wabi.gg/api/auth/discord'),
      }),
    );
    expect(mockMessage.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.not.stringContaining('/onboard') }),
    );
    expect(burstCoalescer.coalesce).not.toHaveBeenCalled();
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it('runs the crisis classifier for a lapsed user, THEN shows the subscribe link (safety is never paywalled — ADR-0011)', async () => {
    process.env.NEXT_PUBLIC_BASE_URL = 'https://wabi.gg';
    (userService.findByDiscordId as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: new Date(),
      timezone: 'UTC',
    });
    (accessResolver.resolve as jest.Mock).mockResolvedValue({
      hasActiveAccess: false,
      subscriptionStatus: 'past_due',
    });
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue({ kind: 'ready', text: 'i guess things are fine' });
    classifier.classify.mockResolvedValue('safe');
    strategyRetrieval.search.mockResolvedValue([]);

    await service.handle(mockMessage);

    // The LLM classifier is the only layer that catches a paraphrased, no-keyword crisis. It MUST
    // run for a consented-but-lapsed user — coaching is gated, safety is not.
    expect(classifier.classify).toHaveBeenCalledWith('i guess things are fine');
    expect(mockMessage.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        // Dashboard carries the Subscribe control that starts checkout (issue #28).
        content: expect.stringContaining('https://wabi.gg/dashboard'),
      }),
    );
    expect(coach.generate).not.toHaveBeenCalled();
  });

  it('escalates a lapsed user in crisis instead of paywalling them (ADR-0011/0021)', async () => {
    process.env.NEXT_PUBLIC_BASE_URL = 'https://wabi.gg';
    (userService.findByDiscordId as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: new Date(),
      timezone: 'UTC',
    });
    (accessResolver.resolve as jest.Mock).mockResolvedValue({
      hasActiveAccess: false,
      subscriptionStatus: 'canceled',
    });
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue({
      kind: 'ready',
      text: "i just don't see the point anymore",
    });
    classifier.classify.mockResolvedValue('crisis');
    strategyRetrieval.search.mockResolvedValue([]);

    await service.handle(mockMessage);

    // Crisis response fires; the lapsed user is NOT handed a subscribe prompt instead.
    expect(escalation.escalate).toHaveBeenCalledWith('123', 'classifier');
    expect(mockMessage.reply).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Subscribe') }),
    );
    expect(coach.generate).not.toHaveBeenCalled();
  });

  it('escalates on classifier crisis and quarantines session', async () => {
    (userService.findByDiscordId as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: new Date(),
      timezone: 'UTC',
    });
    (accessResolver.resolve as jest.Mock).mockResolvedValue({
      hasActiveAccess: true,
      subscriptionStatus: 'trialing',
    });
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue({ kind: 'ready', text: 'batch' });
    classifier.classify.mockResolvedValue('crisis');
    strategyRetrieval.search.mockResolvedValue([]);

    await service.handle(mockMessage);

    // The classifier path now crosses ONE seam for the whole crisis response — it no longer
    // hand-assembles quarantine/log/aftermath inline (which used to double-fire via onCrisis).
    expect(escalation.escalate).toHaveBeenCalledTimes(1);
    expect(escalation.escalate).toHaveBeenCalledWith('123', 'classifier');
    // The returned crisis payload is rendered on the DM channel.
    expect(mockMessage.reply).toHaveBeenCalledWith(crisisPayload);
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
    (userService.findByDiscordId as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: new Date(),
      timezone: 'UTC',
    });
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue({ kind: 'ready', text: 'test message' });
    classifier.classify.mockResolvedValue('safe');
    (accessResolver.resolve as jest.Mock).mockResolvedValue({
      hasActiveAccess: true,
      subscriptionStatus: 'trialing',
    });
    strategyRetrieval.search.mockResolvedValue([]);
    sessionBuffer.getContext.mockResolvedValue(null);
    (memoryStore.search as jest.Mock).mockResolvedValue([
      { id: 'm1', content: 'Tilts in ranked after losing two games in a row' },
    ]);
    coach.generate.mockResolvedValue("That sounds tough. Hang in there.");

    await service.handle(mockMessage);

    expect(coach.generate).toHaveBeenCalled();
    expect(strategyRetrieval.search).toHaveBeenCalled();
    expect(sessionBuffer.append).toHaveBeenCalled();
    // Read-back: retrieved memory is injected into the coach prompt (now the 2nd arg — the assembled
    // prompt — with the system persona as the 1st; shaping lives in buildCoachPrompt).
    expect(memoryStore.search).toHaveBeenCalledWith('123', 'test message');
    expect(coach.generate).toHaveBeenCalledWith(
      expect.stringContaining('compassionate DM companion'),
      expect.stringContaining('Tilts in ranked'),
    );
    expect(mockMessage.reply).toHaveBeenCalledWith("That sounds tough. Hang in there.");
  });

  it('sends the coach reply without waiting on memory persistence', async () => {
    // mem0 ADD now runs hybrid vector+graph extraction (~20s+). deriveAndStore must NOT block the
    // user-visible reply — otherwise the bot appears to never respond. Simulate a persist that never
    // resolves; handle must still complete and reply.
    (userService.findByDiscordId as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: new Date(),
      timezone: 'UTC',
    });
    (accessResolver.resolve as jest.Mock).mockResolvedValue({
      hasActiveAccess: true,
      subscriptionStatus: 'trialing',
    });
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue({ kind: 'ready', text: 'test message' });
    classifier.classify.mockResolvedValue('safe');
    strategyRetrieval.search.mockResolvedValue([]);
    sessionBuffer.getContext.mockResolvedValue(null);
    coach.generate.mockResolvedValue('That sounds tough. Hang in there.');
    // Never resolves — mimics a slow/hung hybrid extraction.
    (memoryStore.deriveAndStore as jest.Mock).mockReturnValue(new Promise<void>(() => {}));

    await service.handle(mockMessage);

    expect(memoryStore.deriveAndStore).toHaveBeenCalled();
    expect(mockMessage.reply).toHaveBeenCalledWith('That sounds tough. Hang in there.');
  });

  it('cancels pending coach turn on crisis', async () => {
    service.cancelPending('123');
    expect(burstCoalescer.cancel).toHaveBeenCalledWith('123');
  });

  it('classifier and retrieval run concurrently (pipeline order)', async () => {
    (userService.findByDiscordId as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: new Date(),
      timezone: 'UTC',
    });
    (accessResolver.resolve as jest.Mock).mockResolvedValue({
      hasActiveAccess: true,
      subscriptionStatus: 'trialing',
    });
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue({ kind: 'ready', text: 'test message' });
    classifier.classify.mockResolvedValue('safe');
    strategyRetrieval.search.mockResolvedValue([]);
    sessionBuffer.getContext.mockResolvedValue(null);
    coach.generate.mockResolvedValue("That sounds tough. Hang in there.");

    await service.handle(mockMessage);

    expect(classifier.classify).toHaveBeenCalledWith('test message');
    expect(strategyRetrieval.search).toHaveBeenCalledWith('test message');
    expect(coach.generate).toHaveBeenCalled();
    expect(memoryStore.deriveAndStore).toHaveBeenCalledWith(
      '123',
      expect.stringContaining('test message'),
    );
  });

  it('skips interim messages folded into a pending burst (coalesced)', async () => {
    (userService.findByDiscordId as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: new Date(),
      timezone: 'UTC',
    });
    (accessResolver.resolve as jest.Mock).mockResolvedValue({
      hasActiveAccess: true,
      subscriptionStatus: 'trialing',
    });
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue({ kind: 'coalesced' });

    await service.handle(mockMessage);

    expect(classifier.classify).not.toHaveBeenCalled();
    expect(coach.generate).not.toHaveBeenCalled();
  });

  it('sends the hourly-ceiling reply and never coaches it (rate_limited)', async () => {
    (userService.findByDiscordId as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: new Date(),
      timezone: 'UTC',
    });
    (accessResolver.resolve as jest.Mock).mockResolvedValue({
      hasActiveAccess: true,
      subscriptionStatus: 'trialing',
    });
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue({
      kind: 'rate_limited',
      text: 'slow down please',
    });

    await service.handle(mockMessage);

    // The ceiling reply goes straight to the user — it must NOT be classified or coached
    // (the old sentinel bug re-fed it through the pipeline).
    expect(mockMessage.reply).toHaveBeenCalledWith('slow down please');
    expect(classifier.classify).not.toHaveBeenCalled();
    expect(coach.generate).not.toHaveBeenCalled();
  });

  const activeUser = () => {
    (userService.findByDiscordId as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: new Date(),
      timezone: 'UTC',
    });
    (accessResolver.resolve as jest.Mock).mockResolvedValue({
      hasActiveAccess: true,
      subscriptionStatus: 'trialing',
    });
  };

  it('offers a tilt session (not auto-start) when frustration is detected', async () => {
    activeUser();
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue({ kind: 'ready', text: 'teammates keep feeding ugh' });
    classifier.classify.mockResolvedValue('safe');
    strategyRetrieval.search.mockResolvedValue([]);
    tilt.maybeOffer.mockReturnValue('offer for feeding — accept or decline');

    await service.handle(mockMessage);

    expect(tilt.maybeOffer).toHaveBeenCalledWith('123', 'teammates keep feeding ugh');
    expect(mockMessage.reply).toHaveBeenCalledWith(
      expect.stringContaining('accept or decline'),
    );
    // An offer, not an auto-started session, and no coach reply this turn.
    expect(coach.generate).not.toHaveBeenCalled();
  });

  it('does not offer a tilt session during crisis aftermath', async () => {
    activeUser();
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue({ kind: 'ready', text: 'teammates keep feeding ugh' });
    classifier.classify.mockResolvedValue('safe');
    strategyRetrieval.search.mockResolvedValue([]);
    sessionBuffer.getContext.mockResolvedValue(null);
    coach.generate.mockResolvedValue('Gentle reply.');
    (crisisAftermath.isQuarantined as jest.Mock).mockResolvedValue(true);

    await service.handle(mockMessage);

    // Aftermath suppresses the offer entirely — maybeOffer is never consulted.
    expect(tilt.maybeOffer).not.toHaveBeenCalled();
    expect(coach.generate).toHaveBeenCalled();
  });

  it('accepting a pending offer starts a tilt session', async () => {
    activeUser();
    tilt.respondToPendingOffer.mockResolvedValue({
      kind: 'accepted',
      reply: 'Tilt session started. Reset technique: Box breathing.',
    });
    const acceptMsg = { ...mockMessage, content: 'accept', reply: jest.fn().mockResolvedValue({}) } as any;

    await service.handle(acceptMsg);

    expect(tilt.respondToPendingOffer).toHaveBeenCalledWith('123', 'accept');
    expect(acceptMsg.reply).toHaveBeenCalledWith(expect.stringContaining('Reset technique'));
    // The accept short-circuits before classification/coaching.
    expect(burstCoalescer.coalesce).not.toHaveBeenCalled();
    expect(coach.generate).not.toHaveBeenCalled();
  });

  it('declining a pending offer does nothing but acknowledge', async () => {
    activeUser();
    tilt.respondToPendingOffer.mockResolvedValue({ kind: 'declined', reply: 'No problem.' });
    const declineMsg = { ...mockMessage, content: 'decline', reply: jest.fn().mockResolvedValue({}) } as any;

    await service.handle(declineMsg);

    expect(declineMsg.reply).toHaveBeenCalledWith('No problem.');
    // Declining short-circuits before classification/coaching.
    expect(burstCoalescer.coalesce).not.toHaveBeenCalled();
    expect(coach.generate).not.toHaveBeenCalled();
  });

  it('coaches even when retrieval fails (graceful degradation)', async () => {
    (userService.findByDiscordId as jest.Mock).mockResolvedValue({
      discordId: '123',
      consentAcceptedAt: new Date(),
      timezone: 'UTC',
    });
    (accessResolver.resolve as jest.Mock).mockResolvedValue({
      hasActiveAccess: true,
      subscriptionStatus: 'trialing',
    });
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue({ kind: 'ready', text: 'test message' });
    classifier.classify.mockResolvedValue('safe');
    strategyRetrieval.search.mockRejectedValue(new Error('qdrant down'));
    sessionBuffer.getContext.mockResolvedValue(null);
    coach.generate.mockResolvedValue("That sounds tough. Hang in there.");

    await service.handle(mockMessage);

    expect(coach.generate).toHaveBeenCalled();
    expect(mockMessage.reply).toHaveBeenCalledWith("That sounds tough. Hang in there.");
  });
});
