import { DmRouterService, INTENT_DISPATCH_THRESHOLD } from '../dm-router.service';
import { CoachHandler, type DmTurnContext } from '../coach-handler';
import { JournalDmHandler } from '../../journal/journal-dm.handler';
import { JournalSessionService } from '../../journal/journal-session.service';
import type { IntentResult } from '../../intent-router/intent-router.service';

describe('DmRouterService', () => {
  let router: DmRouterService;
  let coachHandler: { handle: jest.Mock };
  let journalHandler: { handle: jest.Mock; beginConversation: jest.Mock };
  let journalSession: { consume: jest.Mock };

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

  beforeEach(() => {
    coachHandler = { handle: jest.fn().mockResolvedValue(undefined) };
    journalHandler = {
      handle: jest.fn().mockResolvedValue(undefined),
      beginConversation: jest.fn().mockResolvedValue(undefined),
    };
    journalSession = { consume: jest.fn().mockResolvedValue(true) };
    router = new DmRouterService(
      coachHandler as unknown as CoachHandler,
      journalHandler as unknown as JournalDmHandler,
      journalSession as unknown as JournalSessionService,
    );
  });

  const coach = (confidence = 0.9): IntentResult => ({ intent: 'coach', confidence });
  const journal = (confidence: number): IntentResult => ({ intent: 'journal', confidence });

  it('dispatches a coach-intent turn to the coach handler', async () => {
    await router.route(ctx(), coach(), false);

    expect(coachHandler.handle).toHaveBeenCalled();
    expect(journalHandler.handle).not.toHaveBeenCalled();
  });

  it('dispatches a confident journal turn with inline content to the journal handler', async () => {
    const c = ctx({ batch: 'journal: had a rough ranked night, feel worthless at the game' });

    await router.route(c, journal(0.9), false);

    expect(journalHandler.handle).toHaveBeenCalledWith(
      c,
      'had a rough ranked night, feel worthless at the game',
    );
    expect(coachHandler.handle).not.toHaveBeenCalled();
  });

  it('arms a two-turn capture for a confident bare journal intent (no inline content)', async () => {
    const c = ctx({ batch: 'i want to journal' });

    await router.route(c, journal(0.95), false);

    expect(journalHandler.beginConversation).toHaveBeenCalledWith(c);
    expect(journalHandler.handle).not.toHaveBeenCalled();
    expect(coachHandler.handle).not.toHaveBeenCalled();
  });

  it('falls back to coaching when journal confidence is below θ', async () => {
    const c = ctx({ batch: 'journal: had a rough ranked night, feel worthless at the game' });

    await router.route(c, journal(INTENT_DISPATCH_THRESHOLD - 0.01), false);

    expect(coachHandler.handle).toHaveBeenCalledWith(c);
    expect(journalHandler.handle).not.toHaveBeenCalled();
  });

  it('falls back to coaching for intents with no handler yet (tilt/mood)', async () => {
    await router.route(ctx(), { intent: 'tilt', confidence: 0.99 }, false);

    expect(coachHandler.handle).toHaveBeenCalled();
    expect(journalHandler.handle).not.toHaveBeenCalled();
  });

  describe('pending-journal capture (two-turn second message)', () => {
    it('captures the turn verbatim as the entry, ignoring intent and inline heuristics', async () => {
      // The capture turn could look like anything — even another "journal" or unrelated text. It is
      // saved verbatim, with no re-routing (one-shot capture).
      const c = ctx({ batch: 'today i actually felt ok for once, won a couple games' });

      await router.route(c, coach(0.9), true);

      expect(journalSession.consume).toHaveBeenCalledWith('123');
      expect(journalHandler.handle).toHaveBeenCalledWith(
        c,
        'today i actually felt ok for once, won a couple games',
      );
      expect(coachHandler.handle).not.toHaveBeenCalled();
      expect(journalHandler.beginConversation).not.toHaveBeenCalled();
    });

    it('falls through to normal routing if the marker expired between check and capture', async () => {
      journalSession.consume.mockResolvedValue(false);
      const c = ctx({ batch: 'just venting about my day' });

      await router.route(c, coach(0.9), true);

      // consume returned false (TTL expired) → not captured; the turn coaches instead.
      expect(journalHandler.handle).not.toHaveBeenCalled();
      expect(coachHandler.handle).toHaveBeenCalledWith(c);
    });
  });
});
