import { DmRouterService, INTENT_DISPATCH_THRESHOLD } from '../dm-router.service';
import { CoachHandler, type DmTurnContext } from '../coach-handler';
import { JournalDmHandler } from '../../journal/journal-dm.handler';
import { JournalSessionService } from '../../journal/journal-session.service';
import { IntentRouterService, type IntentResult } from '../../intent-router/intent-router.service';

describe('DmRouterService', () => {
  let router: DmRouterService;
  let coachHandler: { handle: jest.Mock };
  let journalHandler: { handle: jest.Mock; beginConversation: jest.Mock };
  let journalSession: { isPending: jest.Mock; consume: jest.Mock; clear: jest.Mock };
  let intentRouter: { route: jest.Mock };

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
    };
    journalSession = {
      isPending: jest.fn().mockResolvedValue(false),
      consume: jest.fn().mockResolvedValue(true),
      clear: jest.fn().mockResolvedValue(undefined),
    };
    intentRouter = { route: jest.fn().mockResolvedValue(coach()) };
    router = new DmRouterService(
      coachHandler as unknown as CoachHandler,
      journalHandler as unknown as JournalDmHandler,
      journalSession as unknown as JournalSessionService,
      intentRouter as unknown as IntentRouterService,
    );
  });

  // prepare() runs INSIDE CoachingService's parallel block (alongside the crisis classifier), so it
  // owns the whole routing decision but adds no serial latency. It returns a side-effect-free plan plus
  // the raw verdict (for the observe-only intent trace upstream); execution is deferred to dispatch().
  describe('prepare', () => {
    it('returns a journal-capture plan and SKIPS the intent LLM when a capture is armed', async () => {
      journalSession.isPending.mockResolvedValue(true);

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

    it('plans a one-turn journal-inline when a confident journal verdict carries inline content', async () => {
      intentRouter.route.mockResolvedValue(journal(0.9));

      const decision = await router.prepare(
        '123',
        'journal: had a rough ranked night, feel worthless at the game',
        {},
      );

      expect(decision.plan).toEqual({
        kind: 'journal-inline',
        content: 'had a rough ranked night, feel worthless at the game',
      });
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

    it('plans coach for confident intents with no handler yet (tilt/mood)', async () => {
      intentRouter.route.mockResolvedValue({ intent: 'tilt', confidence: 0.99 });

      const decision = await router.prepare('123', 'i keep losing and raging', {});

      expect(decision.plan).toEqual({ kind: 'coach' });
    });
  });

  describe('dispatch', () => {
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
      journalSession.consume.mockResolvedValue(true);
      const c = ctx({ batch: 'today i actually felt ok for once, won a couple games' });

      await router.dispatch(c, { kind: 'journal-capture' });

      expect(journalSession.consume).toHaveBeenCalledWith('123');
      expect(journalHandler.handle).toHaveBeenCalledWith(
        c,
        'today i actually felt ok for once, won a couple games',
      );
      expect(coachHandler.handle).not.toHaveBeenCalled();
    });

    it('falls back to coaching if the capture marker expired between prepare and dispatch', async () => {
      // The marker was armed at prepare() but its TTL lapsed before this atomic consume. With no intent
      // verdict (the LLM was skipped), coaching is the universal fallback rather than a re-prompt.
      journalSession.consume.mockResolvedValue(false);
      const c = ctx({ batch: 'just venting about my day' });

      await router.dispatch(c, { kind: 'journal-capture' });

      expect(journalHandler.handle).not.toHaveBeenCalled();
      expect(coachHandler.handle).toHaveBeenCalledWith(c);
    });
  });

  describe('clearPending', () => {
    it('drops the pending-journal marker (used by the crisis branch upstream)', async () => {
      await router.clearPending('123');

      expect(journalSession.clear).toHaveBeenCalledWith('123');
    });
  });
});
