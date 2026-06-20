// DmRouterService imports TiltDmHandler → TiltService → SchedulerService → pg-boss (ESM). pg-boss is
// never exercised in these unit tests; mock it so jest can parse the import chain.
jest.mock('pg-boss', () => ({
  PgBoss: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    createQueue: jest.fn().mockResolvedValue(undefined),
    schedule: jest.fn().mockResolvedValue(undefined),
    work: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { DmRouterService, INTENT_DISPATCH_THRESHOLD, type RoutingPlan } from '../dm-router.service';
import { CoachHandler, type DmTurnContext } from '../coach-handler';
import { JournalDmHandler } from '../../journal/journal-dm.handler';
import { SpokeSessionService } from '../../spoke-session/spoke-session.service';
// Type-only: these pull TiltService → Scheduler → pg-boss (ESM) at runtime; the spec only needs the
// types for the constructor casts, so importing them as types avoids loading that chain.
import type { TiltDmHandler } from '../../tilt/tilt-dm.handler';
import type { MoodDmHandler } from '../../mood/mood-dm.handler';
import { IntentRouterService, type IntentResult } from '../../intent-router/intent-router.service';

type SpokeMock = {
  intent: string;
  description: string;
  defaultTool: string;
  tools: Array<{ name: string; description: string; access: 'any' | 'active' }>;
  invoke: jest.Mock;
  resume: jest.Mock;
};

describe('DmRouterService', () => {
  let router: DmRouterService;
  let coachHandler: SpokeMock;
  let journalHandler: SpokeMock;
  let spokeSession: { active: jest.Mock; consume: jest.Mock; clear: jest.Mock };
  let intentRouter: { route: jest.Mock };
  let tiltHandler: SpokeMock;
  let moodHandler: SpokeMock;

  const spokeMock = (intent: string, defaultTool: string, tools: SpokeMock['tools']): SpokeMock => ({
    intent,
    description: `${intent} spoke`,
    defaultTool,
    tools,
    invoke: jest.fn().mockResolvedValue({ kind: 'handled' }),
    resume: jest.fn().mockResolvedValue({ kind: 'handled' }),
  });

  const ctx = (over: Partial<DmTurnContext> = {}): DmTurnContext => ({
    message: { content: 'hey', reply: jest.fn() } as any,
    userId: '123',
    batch: 'hey',
    screenedBatch: { text: 'hey' } as any,
    session: null,
    strategies: [],
    inAftermath: false,
    timezone: 'UTC',
    traceId: 'trace-1',
    ...over,
  });

  const coach = (confidence = 0.9): IntentResult => ({ intent: 'coach', confidence });
  const journal = (confidence: number): IntentResult => ({ intent: 'journal', confidence });

  beforeEach(() => {
    coachHandler = spokeMock('coach', 'coach', [{ name: 'coach', description: '', access: 'active' }]);
    journalHandler = spokeMock('journal', 'give_prompt', [
      { name: 'save_entry', description: '', access: 'active' },
      { name: 'give_prompt', description: '', access: 'active' },
      { name: 'get_entry', description: '', access: 'any' },
    ]);
    tiltHandler = spokeMock('tilt', 'offer_session', [
      { name: 'offer_session', description: '', access: 'active' },
    ]);
    moodHandler = spokeMock('mood', 'log_mood', [{ name: 'log_mood', description: '', access: 'active' }]);
    spokeSession = {
      active: jest.fn().mockResolvedValue(null),
      consume: jest.fn().mockResolvedValue('journal'),
      clear: jest.fn().mockResolvedValue(undefined),
    };
    intentRouter = { route: jest.fn().mockResolvedValue(coach()) };
    router = new DmRouterService(
      coachHandler as unknown as CoachHandler,
      journalHandler as unknown as JournalDmHandler,
      spokeSession as unknown as SpokeSessionService,
      intentRouter as unknown as IntentRouterService,
      tiltHandler as unknown as TiltDmHandler,
      moodHandler as unknown as MoodDmHandler,
    );
  });

  // prepare() runs INSIDE CoachingService's parallel block (alongside the crisis classifier), so it owns
  // the whole routing decision but adds no serial latency. It returns a side-effect-free plan, the raw
  // verdict, and the plan's access tier (read from the registry); execution is deferred to dispatch().
  describe('prepare', () => {
    it('returns a resume plan and SKIPS the intent LLM when a capture floor is held', async () => {
      spokeSession.active.mockResolvedValue('journal');

      const decision = await router.prepare('123', 'today i won a couple games', {});

      expect(decision.plan).toEqual({ kind: 'resume', intent: 'journal' });
      // A capture resume is always a write → gated active-only (ADR-0011).
      expect(decision.access).toBe('active');
      expect(intentRouter.route).not.toHaveBeenCalled();
      expect(decision.verdict).toEqual({ intent: 'journal', confidence: 1 });
      // The stable fact the crisis-safety layer reads to clear the floor (ADR-0030) — not plan.kind.
      expect(decision.isCapture).toBe(true);
    });

    // The router reports its model + token usage out-of-band (4th sink arg); prepare surfaces it on the
    // decision so the hub can stamp the manual `intent` span. A capture resume skips the LLM → no telemetry.
    it('surfaces the router call telemetry (model + usage) on the decision', async () => {
      intentRouter.route.mockImplementation(async (_b: string, _c: unknown, _ctx: unknown, onTelemetry?: (t: unknown) => void) => {
        onTelemetry?.({ model: 'qwopus', usage: { inputTokens: 30, outputTokens: 4 } });
        return coach(0.9);
      });

      const decision = await router.prepare('123', 'hi', {});

      expect(decision.verdictTelemetry).toEqual({ model: 'qwopus', usage: { inputTokens: 30, outputTokens: 4 } });
    });

    it('carries no verdict telemetry on a capture resume (the intent LLM is skipped)', async () => {
      spokeSession.active.mockResolvedValue('journal');

      const decision = await router.prepare('123', 'hi', {});

      expect(decision.verdictTelemetry).toBeUndefined();
    });

    it('routes the intent and plans coach for a coach verdict', async () => {
      intentRouter.route.mockResolvedValue(coach(0.9));

      const decision = await router.prepare('123', 'how do i stop tilting', { recentTurns: undefined });

      // The router is handed the generated catalogue (intents + tools) alongside the batch and context.
      expect(intentRouter.route).toHaveBeenCalledWith(
        'how do i stop tilting',
        expect.arrayContaining([expect.objectContaining({ intent: 'journal', tools: expect.any(Array) })]),
        { recentTurns: undefined },
        expect.any(Function), // out-of-band telemetry sink
      );
      expect(decision.plan).toEqual({ kind: 'invoke', intent: 'coach', tool: 'coach' });
      expect(decision.access).toBe('active');
      expect(decision.verdict).toEqual(coach(0.9));
    });

    // With the regex extractor retired, a journal verdict that carries NO tool falls back to the spoke's
    // safe default (give_prompt) rather than guessing the message is an entry — never saves on a guess.
    it('falls back to the give_prompt default for a journal verdict with no tool — never saves on a guess', async () => {
      intentRouter.route.mockResolvedValue(journal(0.9));

      const decision = await router.prepare('123', 'journal: had a rough night', {});

      expect(decision.plan).toEqual({ kind: 'invoke', intent: 'journal', tool: 'give_prompt' });
    });

    it('plans coach when journal confidence is below θ', async () => {
      intentRouter.route.mockResolvedValue(journal(INTENT_DISPATCH_THRESHOLD - 0.01));

      const decision = await router.prepare('123', 'journal: had a rough night', {});

      expect(decision.plan).toEqual({ kind: 'invoke', intent: 'coach', tool: 'coach' });
    });

    it('plans the give_prompt tool when the verdict asks for a prompt, despite inline-looking text', async () => {
      intentRouter.route.mockResolvedValue({ intent: 'journal', confidence: 0.9, tool: 'give_prompt' });

      const decision = await router.prepare('123', 'i need a journal entry prompt', {});

      expect(decision.plan).toEqual({ kind: 'invoke', intent: 'journal', tool: 'give_prompt' });
    });

    it('plans the save_entry tool (active) when the verdict says save_entry', async () => {
      intentRouter.route.mockResolvedValue({ intent: 'journal', confidence: 0.9, tool: 'save_entry' });

      const decision = await router.prepare('123', 'had a rough ranked night, feel worthless', {});

      expect(decision.plan).toEqual({ kind: 'invoke', intent: 'journal', tool: 'save_entry' });
      expect(decision.access).toBe('active');
      // A fresh invoke is not a capture resume.
      expect(decision.isCapture).toBe(false);
    });

    it('plans the get_entry tool at ANY tier when the verdict asks to read back an entry', async () => {
      intentRouter.route.mockResolvedValue({ intent: 'journal', confidence: 0.9, tool: 'get_entry' });

      const decision = await router.prepare('123', 'what did i journal yesterday', {});

      expect(decision.plan).toEqual({ kind: 'invoke', intent: 'journal', tool: 'get_entry' });
      // A read of one's own data is allowed at any tier — the registry carries this on the ToolSpec.
      expect(decision.access).toBe('any');
    });

    it('routes a confident tilt verdict to the tilt spoke (offer_session)', async () => {
      intentRouter.route.mockResolvedValue({ intent: 'tilt', confidence: 0.99 });

      const decision = await router.prepare('123', 'i keep losing and raging', {});

      expect(decision.plan).toEqual({ kind: 'invoke', intent: 'tilt', tool: 'offer_session' });
      expect(decision.access).toBe('active');
    });

    it('routes a confident mood verdict to the mood spoke (log_mood)', async () => {
      intentRouter.route.mockResolvedValue({ intent: 'mood', confidence: 0.9 });

      const decision = await router.prepare('123', 'i want to log my mood', {});

      expect(decision.plan).toEqual({ kind: 'invoke', intent: 'mood', tool: 'log_mood' });
    });

    it('threads router-extracted args onto the mood invoke plan', async () => {
      intentRouter.route.mockResolvedValue({ intent: 'mood', confidence: 0.95, tool: 'log_mood', args: { rating: 4 } });

      const decision = await router.prepare('123', 'set my mood to four', {});

      expect(decision.plan).toEqual({ kind: 'invoke', intent: 'mood', tool: 'log_mood', args: { rating: 4 } });
    });

    it('routes back to the mood spoke (resume) when the mood floor is held, skipping the LLM', async () => {
      spokeSession.active.mockResolvedValue('mood');

      const decision = await router.prepare('123', 'feeling like a 4', {});

      expect(decision.plan).toEqual({ kind: 'resume', intent: 'mood' });
      expect(intentRouter.route).not.toHaveBeenCalled();
      expect(decision.verdict).toEqual({ intent: 'mood', confidence: 1 });
    });

    it('plans coach for a sub-θ tilt verdict', async () => {
      intentRouter.route.mockResolvedValue({ intent: 'tilt', confidence: INTENT_DISPATCH_THRESHOLD - 0.01 });

      const decision = await router.prepare('123', 'meh', {});

      expect(decision.plan).toEqual({ kind: 'invoke', intent: 'coach', tool: 'coach' });
    });

    it('ignores a stale/unknown active-floor value and routes fresh', async () => {
      spokeSession.active.mockResolvedValue('gibberish');
      intentRouter.route.mockResolvedValue(coach(0.9));

      const decision = await router.prepare('123', 'hello', {});

      expect(intentRouter.route).toHaveBeenCalled();
      expect(decision.plan).toEqual({ kind: 'invoke', intent: 'coach', tool: 'coach' });
    });
  });

  describe('dispatch', () => {
    const invoke = (intent: 'coach' | 'journal' | 'tilt' | 'mood', tool: string): RoutingPlan => ({
      kind: 'invoke',
      intent,
      tool,
    });

    it('dispatches an invoke plan to the named spoke tool', async () => {
      const c = ctx();
      await router.dispatch(c, invoke('journal', 'get_entry'));

      expect(journalHandler.invoke).toHaveBeenCalledWith('get_entry', c, undefined);
      expect(coachHandler.invoke).not.toHaveBeenCalled();
    });

    it('dispatches a tilt invoke plan to the tilt spoke (offer made → handled)', async () => {
      tiltHandler.invoke.mockResolvedValue({ kind: 'handled' });
      const c = ctx();

      await router.dispatch(c, invoke('tilt', 'offer_session'));

      expect(tiltHandler.invoke).toHaveBeenCalledWith('offer_session', c, undefined);
      expect(coachHandler.invoke).not.toHaveBeenCalled();
    });

    it('falls through to coach when a spoke declines the turn (offer pending / aftermath)', async () => {
      tiltHandler.invoke.mockResolvedValue({ kind: 'fallthrough' });
      const c = ctx();

      await router.dispatch(c, invoke('tilt', 'offer_session'));

      expect(coachHandler.invoke).toHaveBeenCalledWith('coach', c);
    });

    it('dispatches a mood invoke plan to the mood spoke prompt tool', async () => {
      const c = ctx();
      await router.dispatch(c, invoke('mood', 'log_mood'));

      expect(moodHandler.invoke).toHaveBeenCalledWith('log_mood', c, undefined);
    });

    it('passes the invoke plan args through to the spoke invoke', async () => {
      const c = ctx();
      await router.dispatch(c, { kind: 'invoke', intent: 'mood', tool: 'log_mood', args: { rating: 4 } });

      expect(moodHandler.invoke).toHaveBeenCalledWith('log_mood', c, { rating: 4 });
    });

    it('resumes the mood capture on a resume plan (spoke owns the consume)', async () => {
      moodHandler.resume.mockResolvedValue({ kind: 'handled' });
      const c = ctx({ batch: '4' });

      await router.dispatch(c, { kind: 'resume', intent: 'mood' });

      expect(moodHandler.resume).toHaveBeenCalledWith(c);
      expect(coachHandler.invoke).not.toHaveBeenCalled();
    });

    it('falls through to coach when the mood spoke resume falls through (floor expired)', async () => {
      moodHandler.resume.mockResolvedValue({ kind: 'fallthrough' });
      const c = ctx();

      await router.dispatch(c, { kind: 'resume', intent: 'mood' });

      expect(coachHandler.invoke).toHaveBeenCalledWith('coach', c);
    });

    it('dispatches a coach invoke plan to the coach spoke', async () => {
      const c = ctx();
      await router.dispatch(c, invoke('coach', 'coach'));

      expect(coachHandler.invoke).toHaveBeenCalledWith('coach', c, undefined);
      expect(journalHandler.invoke).not.toHaveBeenCalled();
    });

    it('dispatches a journal save_entry invoke plan (whole batch is the entry)', async () => {
      const c = ctx();
      await router.dispatch(c, invoke('journal', 'save_entry'));

      expect(journalHandler.invoke).toHaveBeenCalledWith('save_entry', c, undefined);
      expect(coachHandler.invoke).not.toHaveBeenCalled();
    });

    it('dispatches a journal give_prompt invoke plan (arm the two-turn capture)', async () => {
      const c = ctx();
      await router.dispatch(c, invoke('journal', 'give_prompt'));

      expect(journalHandler.invoke).toHaveBeenCalledWith('give_prompt', c, undefined);
    });

    it('resumes the journal capture on a resume plan (spoke owns the consume)', async () => {
      journalHandler.resume.mockResolvedValue({ kind: 'handled' });
      const c = ctx({ batch: 'today i actually felt ok for once' });

      await router.dispatch(c, { kind: 'resume', intent: 'journal' });

      expect(journalHandler.resume).toHaveBeenCalledWith(c);
      expect(coachHandler.invoke).not.toHaveBeenCalled();
    });

    it('falls through to coach when the journal spoke resume falls through (floor expired)', async () => {
      journalHandler.resume.mockResolvedValue({ kind: 'fallthrough' });
      const c = ctx({ batch: 'just venting about my day' });

      await router.dispatch(c, { kind: 'resume', intent: 'journal' });

      expect(coachHandler.invoke).toHaveBeenCalledWith('coach', c);
    });
  });

  describe('clearPending', () => {
    it('drops the pending capture marker (used by the crisis branch upstream)', async () => {
      await router.clearPending('123');

      expect(spokeSession.clear).toHaveBeenCalledWith('123');
    });
  });
});
