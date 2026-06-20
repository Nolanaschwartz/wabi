import { MoodDmHandler } from '../mood-dm.handler';
import { MoodService } from '../mood.service';
import { SpokeSessionService } from '../../spoke-session/spoke-session.service';
import type { DmTurnContext } from '../../coaching/coach-handler';

describe('MoodDmHandler', () => {
  let handler: MoodDmHandler;
  let mood: { create: jest.Mock; trend: jest.Mock };
  let spokeSession: { setActive: jest.Mock; consume: jest.Mock };

  const ctx = (over: Partial<DmTurnContext> = {}): DmTurnContext => ({
    message: { content: 'i want to log my mood', reply: jest.fn().mockResolvedValue({}) } as any,
    userId: '123',
    batch: 'i want to log my mood',
    screenedBatch: { text: 'i want to log my mood' } as any,
    session: null,
    strategies: [],
    inAftermath: false,
    timezone: 'UTC',
    traceId: 'trace-1',
    ...over,
  });

  beforeEach(() => {
    mood = { create: jest.fn().mockResolvedValue(undefined), trend: jest.fn().mockResolvedValue(0) };
    spokeSession = {
      setActive: jest.fn().mockResolvedValue(undefined),
      consume: jest.fn().mockResolvedValue('mood'),
    };
    handler = new MoodDmHandler(mood as unknown as MoodService, spokeSession as unknown as SpokeSessionService);
  });

  describe('Spoke interface (invoke / resume)', () => {
    it('exposes log_mood (active) as its tool', () => {
      expect(handler.intent).toBe('mood');
      expect(handler.tools).toEqual([expect.objectContaining({ name: 'log_mood', access: 'active' })]);
    });

    it('invoke prompts for a rating, arms the floor, and reports handled', async () => {
      const result = await handler.invoke('log_mood', ctx());

      expect(spokeSession.setActive).toHaveBeenCalledWith('123', 'mood');
      expect(mood.create).not.toHaveBeenCalled();
      expect(result).toEqual({ kind: 'handled' });
    });

    // Tier 1: the router extracted the rating as a tool argument → log in one shot, no floor, no regex.
    it('invoke logs the router-extracted rating in one shot (no prompt, no floor)', async () => {
      const result = await handler.invoke('log_mood', ctx({ batch: 'set my mood to four' }), { rating: 4 });

      expect(mood.create).toHaveBeenCalledWith('123', { rating: 4, emoji: expect.any(String) });
      expect(spokeSession.setActive).not.toHaveBeenCalled();
      expect(result).toEqual({ kind: 'handled' });
    });

    // Tier 2: no router arg, but the message itself carries a 1–5 → the regex still one-shots it.
    it('invoke falls back to the batch regex when no router arg is given', async () => {
      const result = await handler.invoke('log_mood', ctx({ batch: 'set my mood to 5' }));

      expect(mood.create).toHaveBeenCalledWith('123', { rating: 5, emoji: expect.any(String) });
      expect(spokeSession.setActive).not.toHaveBeenCalled();
      expect(result).toEqual({ kind: 'handled' });
    });

    // Tier 3: neither arg nor a parseable number → prompt and arm the floor (the original behaviour).
    it('invoke prompts when neither a router arg nor a batch number is present', async () => {
      const result = await handler.invoke('log_mood', ctx({ batch: 'log my mood please' }));

      expect(mood.create).not.toHaveBeenCalled();
      expect(spokeSession.setActive).toHaveBeenCalledWith('123', 'mood');
      expect(result).toEqual({ kind: 'handled' });
    });

    // The one-shot path produces the SAME confirmation as the two-turn capture (one writer).
    it('invoke confirms a one-shot log with the (n/5) line and 7-day trend', async () => {
      mood.trend.mockResolvedValue(3.4);
      const c = ctx({ batch: 'set my mood to four' });

      await handler.invoke('log_mood', c, { rating: 4 });

      expect(c.message.reply).toHaveBeenCalledWith(expect.stringContaining('4/5'));
      expect(c.message.reply).toHaveBeenCalledWith(expect.stringContaining('3.4'));
    });

    it('resume consumes the floor and logs the rating when claimed', async () => {
      spokeSession.consume.mockResolvedValue('mood');
      const c = ctx({ batch: 'feeling like a 4' });

      const result = await handler.resume(c);

      expect(spokeSession.consume).toHaveBeenCalledWith('123');
      expect(mood.create).toHaveBeenCalledWith('123', { rating: 4, emoji: expect.any(String) });
      expect(result).toEqual({ kind: 'handled' });
    });

    it('resume falls through (no log) when the floor expired', async () => {
      spokeSession.consume.mockResolvedValue(null);

      const result = await handler.resume(ctx({ batch: '4' }));

      expect(mood.create).not.toHaveBeenCalled();
      expect(result).toEqual({ kind: 'fallthrough' });
    });
  });

  describe('promptForRating (turn 1)', () => {
    it('arms the mood floor and asks for a 1–5, writing nothing', async () => {
      const c = ctx();

      await handler.promptForRating(c);

      expect(spokeSession.setActive).toHaveBeenCalledWith('123', 'mood');
      expect(c.message.reply).toHaveBeenCalledWith(expect.stringMatching(/1.*5/));
      expect(mood.create).not.toHaveBeenCalled();
    });
  });

  describe('capture (turn 2)', () => {
    it('parses the rating, logs it, and confirms with the trend', async () => {
      mood.trend.mockResolvedValue(3.4);
      const c = ctx({ batch: 'feeling like a 4 today' });

      await handler.capture(c);

      expect(mood.create).toHaveBeenCalledWith('123', { rating: 4, emoji: expect.any(String) });
      expect(c.message.reply).toHaveBeenCalledWith(expect.stringContaining('4'));
      expect(c.message.reply).toHaveBeenCalledWith(expect.stringContaining('3.4'));
    });

    it('omits the trend line when there is no history yet', async () => {
      mood.trend.mockResolvedValue(0);
      const c = ctx({ batch: '5' });

      await handler.capture(c);

      expect(mood.create).toHaveBeenCalledWith('123', { rating: 5, emoji: expect.any(String) });
    });

    it('replies gracefully and writes nothing when no 1–5 is given', async () => {
      const c = ctx({ batch: 'not sure honestly' });

      await handler.capture(c);

      expect(mood.create).not.toHaveBeenCalled();
      expect(c.message.reply).toHaveBeenCalledWith(expect.stringMatching(/1.*5|didn't catch|anytime/i));
    });
  });
});
