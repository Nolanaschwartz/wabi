import { PlayoutDrain } from './playout-drain';

// settle: let a resolved/queued microtask-or-macrotask promise win.
const settled = (p: Promise<void>) =>
  Promise.race([
    p.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 0)),
  ]);

describe('PlayoutDrain', () => {
  it('stays pending while real audio is still queued, resolves once it drains', async () => {
    const d = new PlayoutDrain();
    const gate = d.whenDrained();

    d.update(true); // tail still playing
    expect(await settled(gate)).toBe(false); // still suppressed

    d.update(false); // outBuf empty + player consumed all real frames
    expect(await settled(gate)).toBe(true); // drained -> un-suppress
  });

  it('resolves the gate on barge/clear() so a cut reply never strands the detector', async () => {
    const d = new PlayoutDrain();
    const gate = d.whenDrained();
    d.update(true);
    expect(await settled(gate)).toBe(false);

    d.clear(); // barge dropped the queued audio
    expect(await settled(gate)).toBe(true);
  });

  it('resolves the gate on teardown, and resolves immediately for gates armed after teardown', async () => {
    const d = new PlayoutDrain();
    const pending = d.whenDrained();
    d.update(true);
    expect(await settled(pending)).toBe(false);

    d.close(); // session torn down
    expect(await settled(pending)).toBe(true);

    // A gate armed after teardown must not hang.
    expect(await settled(d.whenDrained())).toBe(true);
  });

  it('re-arms after a drain: a fresh reply gets its own gate', async () => {
    const d = new PlayoutDrain();

    const first = d.whenDrained();
    d.update(false);
    expect(await settled(first)).toBe(true);

    // Next reply queues audio; its gate must wait again (not inherit the prior resolution).
    const second = d.whenDrained();
    d.update(true);
    expect(await settled(second)).toBe(false);
    d.update(false);
    expect(await settled(second)).toBe(true);
  });
});
