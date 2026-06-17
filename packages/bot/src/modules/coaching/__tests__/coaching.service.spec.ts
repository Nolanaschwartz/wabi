import { CoachingService } from '../coaching.service';
import { CoachHandler } from '../coach-handler';
import { DmRouterService } from '../dm-router.service';
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
    generateDetailed: jest.fn(),
  })),
}));

jest.mock('../message-splitter', () => ({
  splitMessage: jest.fn((text) => [text]),
}));

jest.mock('../../session-buffer/session-buffer.service', () => ({
  SessionBufferService: jest.fn().mockImplementation(() => ({
    append: jest.fn(),
    // getContext is async in the real service; default it to a resolved null so every path (now
    // including the pre-classifier context fetch) gets a thenable, not bare undefined.
    getContext: jest.fn().mockResolvedValue(null),
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
    span: jest.fn(),
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
    // Read by the classifier-context builder; defaults to "not in a session" for every other test.
    hasActiveSession: jest.fn().mockResolvedValue(false),
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
  let intentRouter: { route: jest.Mock };
  let journalDmHandler: {
    intent: string;
    description: string;
    defaultTool: string;
    tools: Array<{ name: string; description: string; access: 'any' | 'active' }>;
    invoke: jest.Mock;
    resume: jest.Mock;
  };
  let spokeSession: { active: jest.Mock; consume: jest.Mock; clear: jest.Mock };

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
    // Observe-only intent router: defaults to coach/0 so dispatch behaviour is unchanged. Individual
    // tests override route() to assert tracing.
    intentRouter = { route: jest.fn().mockResolvedValue({ intent: 'coach', confidence: 0 }) };
    // The coach body now lives in CoachHandler, reached via DmRouterService. Wire the REAL router +
    // handler around the same leaf mocks so every behaviour assertion below (coach.generateDetailed, memory
    // recency, session append, streak, derive) still exercises the real path end-to-end — the
    // extraction is behaviour-identical, and these tests prove it.
    const coachHandler = new CoachHandler(
      coach,
      sessionBuffer,
      langfuseTracer,
      memoryStore,
      habitEngagement,
    );
    // Journal handler is mocked, but the router is REAL — so a confident inline journal verdict really
    // routes here (proved below). Most tests drive the coach path (intent defaults to coach/0).
    journalDmHandler = {
      intent: 'journal',
      description: 'write or reflect',
      defaultTool: 'give_prompt',
      tools: [
        { name: 'save_entry', description: '', access: 'active' },
        { name: 'give_prompt', description: '', access: 'active' },
        { name: 'get_entry', description: '', access: 'any' },
      ],
      invoke: jest.fn().mockResolvedValue({ kind: 'handled' }),
      resume: jest.fn().mockResolvedValue({ kind: 'handled' }),
    };
    // No spoke floor armed by default; consume returns null unless a test arms it.
    spokeSession = {
      active: jest.fn().mockResolvedValue(null),
      consume: jest.fn().mockResolvedValue('journal'),
      clear: jest.fn().mockResolvedValue(undefined),
    };
    const tiltDmHandler = {
      intent: 'tilt',
      description: 'calm frustration',
      defaultTool: 'offer_session',
      tools: [{ name: 'offer_session', description: '', access: 'active' }],
      invoke: jest.fn().mockResolvedValue({ kind: 'handled' }),
      resume: jest.fn().mockResolvedValue({ kind: 'fallthrough' }),
    };
    const moodDmHandler = {
      intent: 'mood',
      description: 'log how they feel',
      defaultTool: 'log_mood',
      tools: [{ name: 'log_mood', description: '', access: 'active' }],
      invoke: jest.fn().mockResolvedValue({ kind: 'handled' }),
      resume: jest.fn().mockResolvedValue({ kind: 'handled' }),
    };
    const dmRouter = new DmRouterService(
      coachHandler,
      journalDmHandler as any,
      spokeSession as any,
      intentRouter as any,
      tiltDmHandler as any,
      moodDmHandler as any,
    );
    service = new CoachingService(
      classifier,
      sessionBuffer,
      coachingSession,
      strategyRetrieval,
      burstCoalescer,
      langfuseTracer,
      accessResolver,
      crisisAftermath,
      escalation as any,
      tilt,
      userService,
      dmRouter,
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
    expect(classifier.classify).toHaveBeenCalledWith(
      'i guess things are fine',
      expect.objectContaining({ inTiltSession: false }),
    );
    expect(mockMessage.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        // Dashboard carries the Subscribe control that starts checkout (issue #28).
        content: expect.stringContaining('https://wabi.gg/dashboard'),
      }),
    );
    expect(coach.generateDetailed).not.toHaveBeenCalled();
  });

  it('lets a lapsed user READ back an entry (get_entry is allowed at any tier — ADR-0011)', async () => {
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
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue({ kind: 'ready', text: 'what did i journal yesterday' });
    classifier.classify.mockResolvedValue('safe');
    strategyRetrieval.search.mockResolvedValue([]);
    sessionBuffer.getContext.mockResolvedValue(null);
    intentRouter.route.mockResolvedValue({ intent: 'journal', confidence: 0.9, tool: 'get_entry' });

    await service.handle(mockMessage);

    // A read survives the lapsed tier: the read-back tool runs, and the user is NOT handed a subscribe prompt.
    expect(journalDmHandler.invoke).toHaveBeenCalledWith('get_entry', expect.anything());
    expect(mockMessage.reply).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Subscribe') }),
    );
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
    expect(escalation.escalate).toHaveBeenCalledWith('123', 'classifier', 'conversation');
    expect(mockMessage.reply).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Subscribe') }),
    );
    expect(coach.generateDetailed).not.toHaveBeenCalled();
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
    expect(escalation.escalate).toHaveBeenCalledWith('123', 'classifier', 'conversation');
    // The returned crisis payload is rendered on the DM channel.
    expect(mockMessage.reply).toHaveBeenCalledWith(crisisPayload);
    expect(coach.generateDetailed).not.toHaveBeenCalled();
    expect(burstCoalescer.cancel).toHaveBeenCalled();
    expect(langfuseTracer.span).toHaveBeenCalledWith(
      expect.objectContaining({
        span: 'classify',
        input: 'batch',
        output: 'crisis',
        isCrisis: true,
      }),
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
    coach.generateDetailed.mockResolvedValue({ text: "That sounds tough. Hang in there.", model: 'test-coach', latencyMs: 0 });

    await service.handle(mockMessage);

    expect(coach.generateDetailed).toHaveBeenCalled();
    expect(strategyRetrieval.search).toHaveBeenCalled();
    expect(sessionBuffer.append).toHaveBeenCalled();
    // Read-back: retrieved memory is injected into the coach prompt (now the 2nd arg — the assembled
    // prompt — with the system persona as the 1st; shaping lives in buildCoachPrompt).
    expect(memoryStore.search).toHaveBeenCalledWith('123', 'test message');
    expect(coach.generateDetailed).toHaveBeenCalledWith(
      expect.stringContaining('compassionate DM companion'),
      expect.stringContaining('Tilts in ranked'),
    );
    expect(mockMessage.reply).toHaveBeenCalledWith("That sounds tough. Hang in there.");
  });

  it('orders recalled memories by recency before building the coach prompt', async () => {
    // Recency-aware recall: equally-relevant facts should reach the prompt newest-first, so the coach
    // leans on what has been salient lately rather than a stale one-off. Search returns them oldest-
    // first to prove the service re-ranks rather than passing mem0's order straight through.
    const DAY = 24 * 60 * 60 * 1000;
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
      { id: 'old', content: 'STALE FACT', similarity: 0.8, updatedAt: Date.now() - 90 * DAY },
      { id: 'new', content: 'FRESH FACT', similarity: 0.8, updatedAt: Date.now() - 1 * DAY },
    ]);
    coach.generateDetailed.mockResolvedValue({ text: 'ok', model: 'test-coach', latencyMs: 0 });

    await service.handle(mockMessage);

    const prompt = coach.generateDetailed.mock.calls[0][1];
    expect(prompt.indexOf('FRESH FACT')).toBeLessThan(prompt.indexOf('STALE FACT'));
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
    coach.generateDetailed.mockResolvedValue({ text: 'That sounds tough. Hang in there.', model: 'test-coach', latencyMs: 0 });
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
    coach.generateDetailed.mockResolvedValue({ text: "That sounds tough. Hang in there.", model: 'test-coach', latencyMs: 0 });

    await service.handle(mockMessage);

    expect(classifier.classify).toHaveBeenCalledWith(
      'test message',
      expect.objectContaining({ inTiltSession: false }),
    );
    expect(strategyRetrieval.search).toHaveBeenCalledWith('test message');
    expect(coach.generateDetailed).toHaveBeenCalled();
    expect(memoryStore.deriveAndStore).toHaveBeenCalledWith(
      '123',
      expect.stringContaining('test message'),
    );
  });

  it('runs the intent router in the parallel block and traces its verdict on a safe turn', async () => {
    activeUser();
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue({ kind: 'ready', text: 'want to journal about tonight' });
    classifier.classify.mockResolvedValue('safe');
    strategyRetrieval.search.mockResolvedValue([]);
    sessionBuffer.getContext.mockResolvedValue(null);
    coach.generateDetailed.mockResolvedValue({ text: 'ok', model: 'test-coach', latencyMs: 0 });
    // Sub-threshold journal verdict: still traced for tuning, but dispatch falls back to the coach.
    intentRouter.route.mockResolvedValue({ intent: 'journal', confidence: 0.5 });

    await service.handle(mockMessage);

    expect(intentRouter.route).toHaveBeenCalledWith(
      'want to journal about tonight',
      expect.any(Array), // the generated spoke catalogue
      expect.objectContaining({ recentTurns: undefined }),
    );
    // The verdict is traced for threshold tuning (intent span carries confidence + router latency)...
    expect(langfuseTracer.span).toHaveBeenCalledWith(
      expect.objectContaining({
        span: 'intent',
        input: 'want to journal about tonight',
        output: 'journal',
        confidence: 0.5,
      }),
    );
    // ...and below θ the turn still reaches the coach (coaching is the fallback).
    expect(coach.generateDetailed).toHaveBeenCalled();
  });

  it('emits a retrieval span with strategy counts/scores/ids and no strategy text on a safe turn', async () => {
    activeUser();
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue({ kind: 'ready', text: 'test message' });
    classifier.classify.mockResolvedValue('safe');
    sessionBuffer.getContext.mockResolvedValue(null);
    coach.generateDetailed.mockResolvedValue({ text: 'ok', model: 'test-coach', latencyMs: 0 });
    strategyRetrieval.search.mockResolvedValue([
      { id: 's1', content: 'box breathing', evidence: 'rct', effectivenessScore: 0.9 },
      { id: 's2', content: 'reframing', evidence: 'meta', effectivenessScore: 0.7 },
    ]);

    await service.handle(mockMessage);

    const retrieval = langfuseTracer.span.mock.calls
      .map((c) => c[0] as any)
      .find((p) => p.span === 'retrieval');
    expect(retrieval).toBeDefined();
    expect(retrieval.metadata.count).toBe(2);
    expect(retrieval.metadata.ids).toEqual(['s1', 's2']);
    expect(retrieval.metadata.scores).toEqual([0.9, 0.7]);
    // No strategy body text crosses into the span.
    expect(retrieval.input).toBe('');
    expect(retrieval.output).toBe('');
    expect(JSON.stringify(retrieval)).not.toContain('box breathing');
  });

  it('includes the query and strategy text on the retrieval span in local full fidelity', async () => {
    activeUser();
    (langfuseTracer as any).localFullFidelity = true;
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue({ kind: 'ready', text: 'help me focus' });
    classifier.classify.mockResolvedValue('safe');
    sessionBuffer.getContext.mockResolvedValue(null);
    coach.generateDetailed.mockResolvedValue({ text: 'ok', model: 'test-coach', latencyMs: 0 });
    strategyRetrieval.search.mockResolvedValue([
      { id: 's1', content: 'box breathing', evidence: 'rct', effectivenessScore: 0.9 },
    ]);

    await service.handle(mockMessage);

    const retrieval = langfuseTracer.span.mock.calls
      .map((c) => c[0] as any)
      .find((p) => p.span === 'retrieval');
    expect(retrieval.input).toBe('help me focus');
    expect(retrieval.output).toContain('box breathing');
    // Metadata still present alongside the verbatim text.
    expect(retrieval.metadata.ids).toEqual(['s1']);
  });

  it('routes a confident inline journal turn (save_entry) to the journal handler verbatim, not the coach', async () => {
    activeUser();
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue({
      kind: 'ready',
      text: 'had a rough ranked night, feel worthless at the game',
    });
    classifier.classify.mockResolvedValue('safe');
    strategyRetrieval.search.mockResolvedValue([]);
    sessionBuffer.getContext.mockResolvedValue(null);
    intentRouter.route.mockResolvedValue({ intent: 'journal', confidence: 0.9, tool: 'save_entry' });

    await service.handle(mockMessage);

    // Real router → journal dispatch through the save_entry tool (whole batch is the entry); coach is
    // not consulted. The verbatim-content write is the spoke's own contract (journal-dm.handler.spec).
    expect(journalDmHandler.invoke).toHaveBeenCalledWith(
      'save_entry',
      expect.objectContaining({ userId: '123', batch: 'had a rough ranked night, feel worthless at the game' }),
    );
    expect(coach.generateDetailed).not.toHaveBeenCalled();
  });

  it('skips the intent-router LLM call when a journal capture is pending, and resumes the spoke', async () => {
    activeUser();
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue({
      kind: 'ready',
      text: 'today i actually felt ok, won a couple games',
    });
    classifier.classify.mockResolvedValue('safe');
    strategyRetrieval.search.mockResolvedValue([]);
    sessionBuffer.getContext.mockResolvedValue(null);
    spokeSession.active.mockResolvedValue('journal');

    await service.handle(mockMessage);

    // The router LLM is predetermined-away — no call.
    expect(intentRouter.route).not.toHaveBeenCalled();
    // The pending turn returns to the journal spoke, which owns the consume + verbatim write; coaching
    // does not run. (The consume-then-write contract is covered in journal-dm.handler.spec.)
    expect(journalDmHandler.resume).toHaveBeenCalledWith(
      expect.objectContaining({ userId: '123', batch: 'today i actually felt ok, won a couple games' }),
    );
    expect(coach.generateDetailed).not.toHaveBeenCalled();
  });

  it('clears the pending journal marker and escalates when the capture turn is a crisis', async () => {
    activeUser();
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue({ kind: 'ready', text: "i don't want to be here anymore" });
    classifier.classify.mockResolvedValue('crisis');
    strategyRetrieval.search.mockResolvedValue([]);
    spokeSession.active.mockResolvedValue('journal');

    await service.handle(mockMessage);

    // The crisis text never reaches the journal writer; the floor is cleared so a later DM routes fresh.
    expect(spokeSession.clear).toHaveBeenCalledWith('123');
    expect(journalDmHandler.resume).not.toHaveBeenCalled();
    expect(journalDmHandler.invoke).not.toHaveBeenCalled();
    expect(escalation.escalate).toHaveBeenCalledWith('123', 'classifier', 'conversation');
  });

  it('discards the intent verdict on a crisis turn (never traced as intent, never dispatched)', async () => {
    activeUser();
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue({ kind: 'ready', text: 'i want to end it' });
    classifier.classify.mockResolvedValue('crisis');
    strategyRetrieval.search.mockResolvedValue([]);
    intentRouter.route.mockResolvedValue({ intent: 'journal', confidence: 0.95 });

    await service.handle(mockMessage);

    expect(escalation.escalate).toHaveBeenCalledWith('123', 'classifier', 'conversation');
    expect(coach.generateDetailed).not.toHaveBeenCalled();
    // The crisis short-circuit happens before the intent trace — the routing verdict is dropped.
    expect(langfuseTracer.span).not.toHaveBeenCalledWith(
      expect.objectContaining({ span: 'intent' }),
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
    expect(coach.generateDetailed).not.toHaveBeenCalled();
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
    expect(coach.generateDetailed).not.toHaveBeenCalled();
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
    expect(coach.generateDetailed).not.toHaveBeenCalled();
  });

  it('does not offer a tilt session during crisis aftermath', async () => {
    activeUser();
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue({ kind: 'ready', text: 'teammates keep feeding ugh' });
    classifier.classify.mockResolvedValue('safe');
    strategyRetrieval.search.mockResolvedValue([]);
    sessionBuffer.getContext.mockResolvedValue(null);
    coach.generateDetailed.mockResolvedValue({ text: 'Gentle reply.', model: 'test-coach', latencyMs: 0 });
    (crisisAftermath.isQuarantined as jest.Mock).mockResolvedValue(true);

    await service.handle(mockMessage);

    // Aftermath suppresses the offer entirely — maybeOffer is never consulted.
    expect(tilt.maybeOffer).not.toHaveBeenCalled();
    expect(coach.generateDetailed).toHaveBeenCalled();
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
    expect(coach.generateDetailed).not.toHaveBeenCalled();
  });

  it('declining a pending offer does nothing but acknowledge', async () => {
    activeUser();
    tilt.respondToPendingOffer.mockResolvedValue({ kind: 'declined', reply: 'No problem.' });
    const declineMsg = { ...mockMessage, content: 'decline', reply: jest.fn().mockResolvedValue({}) } as any;

    await service.handle(declineMsg);

    expect(declineMsg.reply).toHaveBeenCalledWith('No problem.');
    // Declining short-circuits before classification/coaching.
    expect(burstCoalescer.coalesce).not.toHaveBeenCalled();
    expect(coach.generateDetailed).not.toHaveBeenCalled();
  });

  it('feeds active-tilt-session context to the classifier so technique-frustration is not misread as crisis', async () => {
    activeUser();
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue({ kind: 'ready', text: "it's not helping" });
    // The exact false-positive scenario: user mid tilt-reset replies that the technique isn't working.
    (tilt.hasActiveSession as jest.Mock).mockResolvedValue(true);
    classifier.classify.mockResolvedValue('safe');
    strategyRetrieval.search.mockResolvedValue([]);
    sessionBuffer.getContext.mockResolvedValue(null);
    coach.generateDetailed.mockResolvedValue({ text: 'Want to try a different reset?', model: 'test-coach', latencyMs: 0 });

    await service.handle(mockMessage);

    // Classifier is told it's a tilt-reset reply — the context-blind false positive can't fire.
    expect(classifier.classify).toHaveBeenCalledWith(
      "it's not helping",
      expect.objectContaining({ inTiltSession: true }),
    );
    expect(escalation.escalate).not.toHaveBeenCalled();
  });

  it('always passes a context object — cold messages carry inTiltSession:false, not a missing arg', async () => {
    activeUser();
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue({ kind: 'ready', text: 'just chatting' });
    (tilt.hasActiveSession as jest.Mock).mockResolvedValue(false);
    classifier.classify.mockResolvedValue('safe');
    strategyRetrieval.search.mockResolvedValue([]);
    sessionBuffer.getContext.mockResolvedValue(null);
    coach.generateDetailed.mockResolvedValue({ text: 'hey', model: 'test-coach', latencyMs: 0 });

    await service.handle(mockMessage);

    // Uniform: every screening call gets a context object; cold just means inTiltSession false / no turns.
    expect(classifier.classify).toHaveBeenCalledWith(
      'just chatting',
      expect.objectContaining({ inTiltSession: false }),
    );
  });

  it('still classifies when gathering context throws — safety degrades to inTiltSession:false, never blocks', async () => {
    activeUser();
    (burstCoalescer.coalesce as jest.Mock).mockResolvedValue({ kind: 'ready', text: 'rough night' });
    (tilt.hasActiveSession as jest.Mock).mockRejectedValue(new Error('db down'));
    classifier.classify.mockResolvedValue('safe');
    strategyRetrieval.search.mockResolvedValue([]);
    sessionBuffer.getContext.mockResolvedValue(null);
    coach.generateDetailed.mockResolvedValue({ text: 'hey', model: 'test-coach', latencyMs: 0 });

    await service.handle(mockMessage);

    // A failed tilt lookup degrades to inTiltSession:false; it must NOT throw past handle.
    expect(classifier.classify).toHaveBeenCalledWith(
      'rough night',
      expect.objectContaining({ inTiltSession: false }),
    );
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
    coach.generateDetailed.mockResolvedValue({ text: "That sounds tough. Hang in there.", model: 'test-coach', latencyMs: 0 });

    await service.handle(mockMessage);

    expect(coach.generateDetailed).toHaveBeenCalled();
    expect(mockMessage.reply).toHaveBeenCalledWith("That sounds tough. Hang in there.");
  });
});
