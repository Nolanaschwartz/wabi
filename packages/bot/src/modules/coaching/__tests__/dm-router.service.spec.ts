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

import { DmRouterService, INTENT_DISPATCH_THRESHOLD } from '../dm-router.service';
import { CoachHandler, type DmTurnContext } from '../coach-handler';
import { JournalDmHandler } from '../../journal/journal-dm.handler';
import { SpokeSessionService } from '../../spoke-session/spoke-session.service';
// Type-only: these pull TiltService → Scheduler → pg-boss (ESM) at runtime; the spec only needs the
// types for the constructor casts, so importing them as types avoids loading that chain.
import type { TiltDmHandler } from '../../tilt/tilt-dm.handler';
import type { MoodDmHandler } from '../../mood/mood-dm.handler';
import { IntentRouterService, type IntentResult } from '../../intent-router/intent-router.service';

describe('DmRouterService', () => {
  let router: DmRouterService;
  let coachHandler: { handle: jest.Mock };
  let journalHandler: { handle: jest.Mock; beginConversation: jest.Mock; getEntry: jest.Mock };
  let spokeSession: { active: jest.Mock; consume: jest.Mock; clear: jest.Mock };
  let intentRouter: { route: jest.Mock };
  let tiltHandler: { handle: jest.Mock };
  let moodHandler: { promptForRating: jest.Mock; capture: jest.Mock };

  const ctx = (over: Partial<DmTurnContext> = {}): DmTurnContext => ({
    message: { content: 'hey', reply: jest.fn() } as any,
    userId: '123',
    batch: 'hey',
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
    coachHandler = { handle: jest.fn().mockResolvedValue(undefined) };
    journalHandler = {
      handle: jest.fn().mockResolvedValue(undefined),
      beginConversation: jest.fn().mockResolvedValue(undefined),
      getEntry: jest.fn().mockResolvedValue(undefined),
    };
    spokeSession = {
      active: jest.fn().mockResolvedValue(null),
      consume: jest.fn().mockResolvedValue('journal'),
      clear: jest.fn().mockResolvedValue(undefined),
    };
    intentRouter = { route: jest.fn().mockResolvedValue(coach()) };
    tiltHandler = { handle: jest.fn().mockResolvedValue(true) };
    moodHandler = {
      promptForRating: jest.fn().mockResolvedValue(undefined),
      capture: jest.fn().mockResolvedValue(undefined),
    };
    router = new DmRouterService(
      coachHandler as unknown as CoachHandler,
      journalHandler as unknown as JournalDmHandler,
      spokeSession as unknown as SpokeSessionService,
      intentRouter as unknown as IntentRouterService,
      tiltHandler as unknown as TiltDmHandler,
      moodHandler as unknown as MoodDmHandler,
    );
  });

  // prepare() runs INSIDE CoachingService's parallel block (alongside the crisis classifier), so it
  // owns the whole routing decision but adds no serial latency. It returns a side-effect-free plan plus
  // the raw verdict (for the observe-only intent trace upstream); execution is deferred to dispatch().
  describe('prepare', () => {
    it('returns a journal-capture plan and SKIPS the intent LLM when a capture is armed', async () => {
      spokeSession.active.mockResolvedValue('journal');

      const decision = await router.prepare('123', 'today i won a couple games', {});

      expect(decision.plan).toEqual({ kind: 'journal-capture' });
      // The dispatch is predetermined — the LLM call is pointless and must be skipped.
      expect(intentRouter.route).not.toHaveBeenCalled();
      // A synthetic verdict so the upstream trace still records a journal dispatch.
      expect(decision.verdict).toEqual({ intent: 'journal', confidence: 1 });
    });

    it('routes the intent and plans coach for a coach verdict', async () => {
      intentRouter.route.mockResolvedValue(coach(0.9));

      const decision = await router.prepare('123', 'how do i stop tilting', { recentTurns: undefined });

      expect(intentRouter.route).toHaveBeenCalledWith('how do i stop tilting', { recentTurns: undefined });
      expect(decision.plan).toEqual({ kind: 'coach' });
      expect(decision.verdict).toEqual(coach(0.9));
    });

    // With the regex extractor retired, a journal verdict that carries NO tool falls back to a prompt
    // (journal-begin) rather than guessing the message is an entry — the hub never saves on a guess.
    it('falls back to a prompt (journal-begin) for a journal verdict with no tool — never saves on a guess', async () => {
      intentRouter.route.mockResolvedValue(journal(0.9));

      const decision = await router.prepare(
        '123',
        'journal: had a rough ranked night, feel worthless at the game',
        {},
      );

      expect(decision.plan).toEqual({ kind: 'journal-begin' });
    });

    it('plans a two-turn journal-begin for a confident bare journal intent', async () => {
      intentRouter.route.mockResolvedValue(journal(0.95));

      const decision = await router.prepare('123', 'i want to journal', {});

      expect(decision.plan).toEqual({ kind: 'journal-begin' });
    });

    it('plans coach when journal confidence is below θ', async () => {
      intentRouter.route.mockResolvedValue(journal(INTENT_DISPATCH_THRESHOLD - 0.01));

      const decision = await router.prepare(
        '123',
        'journal: had a rough ranked night, feel worthless at the game',
        {},
      );

      expect(decision.plan).toEqual({ kind: 'coach' });
    });

    // The bug fix: "I need a journal entry prompt" is a REQUEST for a prompt, not an entry. The discovery
    // classifier tags it tool=give_prompt, so the hub gives a prompt (journal-begin) and persists nothing
    // — even though the text would otherwise be extracted as inline entry content.
    it('plans journal-begin (give a prompt) when the verdict asks for a prompt, despite inline-looking text', async () => {
      intentRouter.route.mockResolvedValue({ intent: 'journal', confidence: 0.9, tool: 'give_prompt' });

      const decision = await router.prepare('123', 'i need a journal entry prompt', {});

      expect(decision.plan).toEqual({ kind: 'journal-begin' });
    });

    it('plans journal-inline with the VERBATIM message when the verdict says save_entry', async () => {
      intentRouter.route.mockResolvedValue({ intent: 'journal', confidence: 0.9, tool: 'save_entry' });

      const decision = await router.prepare('123', 'had a rough ranked night, feel worthless', {});

      // No more trigger-stripping — the whole message is the entry (consistent with two-turn capture).
      expect(decision.plan).toEqual({
        kind: 'journal-inline',
        content: 'had a rough ranked night, feel worthless',
      });
    });

    it('plans journal-read when the verdict asks to read back an entry (get_entry)', async () => {
      intentRouter.route.mockResolvedValue({ intent: 'journal', confidence: 0.9, tool: 'get_entry' });

      const decision = await router.prepare('123', 'what did i journal yesterday', {});

      expect(decision.plan).toEqual({ kind: 'journal-read' });
    });

    it('routes a confident tilt verdict to the tilt spoke', async () => {
      intentRouter.route.mockResolvedValue({ intent: 'tilt', confidence: 0.99 });

      const decision = await router.prepare('123', 'i keep losing and raging', {});

      expect(decision.plan).toEqual({ kind: 'tilt' });
    });

    it('routes a confident mood verdict to the mood spoke (prompt for a rating)', async () => {
      intentRouter.route.mockResolvedValue({ intent: 'mood', confidence: 0.9 });

      const decision = await router.prepare('123', 'i want to log my mood', {});

      expect(decision.plan).toEqual({ kind: 'mood' });
    });

    it('routes back to the mood spoke (mood-capture) when the mood floor is held, skipping the LLM', async () => {
      spokeSession.active.mockResolvedValue('mood');

      const decision = await router.prepare('123', 'feeling like a 4', {});

      expect(decision.plan).toEqual({ kind: 'mood-capture' });
      expect(intentRouter.route).not.toHaveBeenCalled();
      expect(decision.verdict).toEqual({ intent: 'mood', confidence: 1 });
    });

    it('plans coach for a sub-θ tilt verdict', async () => {
      intentRouter.route.mockResolvedValue({ intent: 'tilt', confidence: INTENT_DISPATCH_THRESHOLD - 0.01 });

      const decision = await router.prepare('123', 'meh', {});

      expect(decision.plan).toEqual({ kind: 'coach' });
    });
  });

  describe('dispatch', () => {
    it('dispatches a journal-read plan to the read-back tool (no write, no floor)', async () => {
      const c = ctx();
      await router.dispatch(c, { kind: 'journal-read' });

      expect(journalHandler.getEntry).toHaveBeenCalledWith(c);
      expect(journalHandler.handle).not.toHaveBeenCalled();
      expect(coachHandler.handle).not.toHaveBeenCalled();
    });

    it('dispatches a tilt plan to the tilt spoke (offer made)', async () => {
      tiltHandler.handle.mockResolvedValue(true);
      const c = ctx();

      await router.dispatch(c, { kind: 'tilt' });

      expect(tiltHandler.handle).toHaveBeenCalledWith(c);
      expect(coachHandler.handle).not.toHaveBeenCalled();
    });

    it('falls back to coach when the tilt spoke does not offer (offer already pending)', async () => {
      tiltHandler.handle.mockResolvedValue(false);
      const c = ctx();

      await router.dispatch(c, { kind: 'tilt' });

      expect(coachHandler.handle).toHaveBeenCalledWith(c);
    });

    it('suppresses the tilt offer during crisis aftermath and coaches instead', async () => {
      const c = ctx({ inAftermath: true });

      await router.dispatch(c, { kind: 'tilt' });

      expect(tiltHandler.handle).not.toHaveBeenCalled();
      expect(coachHandler.handle).toHaveBeenCalledWith(c);
    });

    it('dispatches a mood plan to the mood spoke prompt', async () => {
      const c = ctx();

      await router.dispatch(c, { kind: 'mood' });

      expect(moodHandler.promptForRating).toHaveBeenCalledWith(c);
    });

    it('captures the rating on a mood-capture plan when the floor is claimed', async () => {
      spokeSession.consume.mockResolvedValue('mood');
      const c = ctx({ batch: '4' });

      await router.dispatch(c, { kind: 'mood-capture' });

      expect(spokeSession.consume).toHaveBeenCalledWith('123');
      expect(moodHandler.capture).toHaveBeenCalledWith(c);
      expect(coachHandler.handle).not.toHaveBeenCalled();
    });

    it('falls back to coach if the mood floor expired between prepare and dispatch', async () => {
      spokeSession.consume.mockResolvedValue(null);
      const c = ctx();

      await router.dispatch(c, { kind: 'mood-capture' });

      expect(moodHandler.capture).not.toHaveBeenCalled();
      expect(coachHandler.handle).toHaveBeenCalledWith(c);
    });

    it('dispatches a coach plan to the coach handler', async () => {
      const c = ctx();
      await router.dispatch(c, { kind: 'coach' });

      expect(coachHandler.handle).toHaveBeenCalledWith(c);
      expect(journalHandler.handle).not.toHaveBeenCalled();
    });

    it('dispatches a journal-inline plan with the extracted content', async () => {
      const c = ctx();
      await router.dispatch(c, { kind: 'journal-inline', content: 'rough night at ranked' });

      expect(journalHandler.handle).toHaveBeenCalledWith(c, 'rough night at ranked');
      expect(coachHandler.handle).not.toHaveBeenCalled();
    });

    it('dispatches a journal-begin plan to arm the two-turn capture', async () => {
      const c = ctx();
      await router.dispatch(c, { kind: 'journal-begin' });

      expect(journalHandler.beginConversation).toHaveBeenCalledWith(c);
      expect(journalHandler.handle).not.toHaveBeenCalled();
    });

    it('captures the turn verbatim on a journal-capture plan (atomic consume succeeds)', async () => {
      spokeSession.consume.mockResolvedValue('journal');
      const c = ctx({ batch: 'today i actually felt ok for once, won a couple games' });

      await router.dispatch(c, { kind: 'journal-capture' });

      expect(spokeSession.consume).toHaveBeenCalledWith('123');
      expect(journalHandler.handle).toHaveBeenCalledWith(
        c,
        'today i actually felt ok for once, won a couple games',
      );
      expect(coachHandler.handle).not.toHaveBeenCalled();
    });

    it('falls back to coaching if the capture marker expired between prepare and dispatch', async () => {
      // The marker was armed at prepare() but its TTL lapsed before this atomic consume. With no intent
      // verdict (the LLM was skipped), coaching is the universal fallback rather than a re-prompt.
      spokeSession.consume.mockResolvedValue(null);
      const c = ctx({ batch: 'just venting about my day' });

      await router.dispatch(c, { kind: 'journal-capture' });

      expect(journalHandler.handle).not.toHaveBeenCalled();
      expect(coachHandler.handle).toHaveBeenCalledWith(c);
    });
  });

  describe('clearPending', () => {
    it('drops the pending-journal marker (used by the crisis branch upstream)', async () => {
      await router.clearPending('123');

      expect(spokeSession.clear).toHaveBeenCalledWith('123');
    });
  });
});
