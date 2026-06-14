// TiltDmHandler → TiltService → SchedulerService → pg-boss (ESM). pg-boss is never exercised here, so
// mock it to let jest parse the import chain (mirrors the journal capture integration test).
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

import { TiltDmHandler } from '../tilt-dm.handler';
import type { TiltService } from '../tilt.service';
import type { DmTurnContext } from '../../coaching/coach-handler';

describe('TiltDmHandler', () => {
  let handler: TiltDmHandler;
  let tilt: { offerFromIntent: jest.Mock };

  const ctx = (over: Partial<DmTurnContext> = {}): DmTurnContext => ({
    message: { content: 'cannot catch a break', reply: jest.fn().mockResolvedValue({}) } as any,
    userId: '123',
    batch: 'cannot catch a break',
    session: null,
    strategies: [],
    inAftermath: false,
    timezone: 'UTC',
    traceId: 'trace-1',
    ...over,
  });

  beforeEach(() => {
    tilt = { offerFromIntent: jest.fn().mockReturnValue('Want to start a tilt session? accept / decline') };
    handler = new TiltDmHandler(tilt as unknown as TiltService);
  });

  it('offers a tilt session and replies, returning true', async () => {
    const c = ctx();

    const offered = await handler.handle(c);

    expect(tilt.offerFromIntent).toHaveBeenCalledWith('123', 'cannot catch a break');
    expect(c.message.reply).toHaveBeenCalledWith('Want to start a tilt session? accept / decline');
    expect(offered).toBe(true);
  });

  it('returns false without replying when an offer is already pending (hub falls back to coach)', async () => {
    tilt.offerFromIntent.mockReturnValue(null);
    const c = ctx();

    const offered = await handler.handle(c);

    expect(offered).toBe(false);
    expect(c.message.reply).not.toHaveBeenCalled();
  });

  describe('Spoke interface (invoke / resume)', () => {
    it('exposes offer_session (active) as its tool', () => {
      expect(handler.intent).toBe('tilt');
      expect(handler.tools).toEqual([expect.objectContaining({ name: 'offer_session', access: 'active' })]);
    });

    it('invoke offers the session and reports handled', async () => {
      const result = await handler.invoke('offer_session', ctx());

      expect(tilt.offerFromIntent).toHaveBeenCalled();
      expect(result).toEqual({ kind: 'handled' });
    });

    it('invoke falls through (no offer) when one is already pending', async () => {
      tilt.offerFromIntent.mockReturnValue(null);

      const result = await handler.invoke('offer_session', ctx());

      expect(result).toEqual({ kind: 'fallthrough' });
    });

    it('invoke suppresses the offer during crisis aftermath and falls through', async () => {
      const result = await handler.invoke('offer_session', ctx({ inAftermath: true }));

      expect(tilt.offerFromIntent).not.toHaveBeenCalled();
      expect(result).toEqual({ kind: 'fallthrough' });
    });

    it('resume always falls through — tilt arms no capture floor', async () => {
      const result = await handler.resume(ctx());

      expect(result).toEqual({ kind: 'fallthrough' });
    });
  });
});
