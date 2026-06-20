import { ClassifierContextAssembler } from '../classifier-context-assembler';
import type { TiltService } from '../../tilt/tilt.service';
import type { SessionContext } from '../../session-buffer/session-buffer.service';

describe('ClassifierContextAssembler', () => {
  let tilt: { hasActiveSession: jest.Mock };
  let assembler: ClassifierContextAssembler;

  beforeEach(() => {
    tilt = { hasActiveSession: jest.fn() };
    assembler = new ClassifierContextAssembler(tilt as unknown as TiltService);
  });

  it('returns a populated context on healthy fetches (tilt true + recent turns)', async () => {
    tilt.hasActiveSession.mockResolvedValue(true);
    const session: SessionContext = {
      turns: [{ role: 'user', content: "it's not helping" }],
    } as SessionContext;

    const ctx = await assembler.assemble('123', session);

    expect(tilt.hasActiveSession).toHaveBeenCalledWith('123');
    expect(ctx).toEqual({
      inTiltSession: true,
      recentTurns: [{ role: 'user', content: "it's not helping" }],
    });
  });

  it('omits recentTurns when the session is null (cold turn)', async () => {
    tilt.hasActiveSession.mockResolvedValue(false);

    const ctx = await assembler.assemble('123', null);

    expect(ctx.inTiltSession).toBe(false);
    expect(ctx.recentTurns).toBeUndefined();
  });

  it('omits recentTurns when the session carries no turns', async () => {
    tilt.hasActiveSession.mockResolvedValue(false);

    const ctx = await assembler.assemble('123', { turns: [] } as unknown as SessionContext);

    expect(ctx.inTiltSession).toBe(false);
    expect(ctx.recentTurns).toBeUndefined();
  });

  it('degrades to inTiltSession:false when the tilt fetch throws (fail-soft, ADR-0021)', async () => {
    tilt.hasActiveSession.mockRejectedValue(new Error('db down'));
    const session: SessionContext = {
      turns: [{ role: 'user', content: 'rough night' }],
    } as SessionContext;

    const ctx = await assembler.assemble('123', session);

    // A failed tilt lookup must NOT throw past the assembler — it degrades and still returns the
    // turns it does have, so the safety classifier is never blocked.
    expect(ctx.inTiltSession).toBe(false);
    expect(ctx.recentTurns).toEqual([{ role: 'user', content: 'rough night' }]);
  });
});
