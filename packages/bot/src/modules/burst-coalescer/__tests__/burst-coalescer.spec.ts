import { BurstCoalescer } from '../burst-coalescer.service';

describe('BurstCoalescer', () => {
  let coalescer: BurstCoalescer;

  beforeEach(() => {
    coalescer = new BurstCoalescer();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('coalesces messages into one batch after debounce', async () => {
    const promise = coalescer.coalesce('123', 'hello');
    coalescer.addMessage('123', 'world');

    jest.advanceTimersByTime(3001);
    expect(await promise).toEqual({ kind: 'ready', text: 'hello\nworld' });
  });

  it('reports interim messages as coalesced (folded into the pending burst)', async () => {
    const promise = coalescer.coalesce('123', 'hello');
    const interim = coalescer.coalesce('123', 'world');

    expect(await interim).toEqual({ kind: 'coalesced' });
    jest.advanceTimersByTime(3001);
    expect(await promise).toEqual({ kind: 'ready', text: 'hello\nworld' });
  });

  it('cancels pending turn on crisis', async () => {
    const promise = coalescer.coalesce('123', 'hello');

    coalescer.cancel('123');
    jest.advanceTimersByTime(3001);
    expect(await promise).toEqual({ kind: 'canceled' });
  });

  it('reports a distinct rate_limited result over the hourly ceiling (never a batch)', async () => {
    for (let i = 0; i < 30; i++) {
      const promise = coalescer.coalesce('123', 'msg');
      jest.advanceTimersByTime(3001);
      await promise;
    }

    const result = await coalescer.coalesce('123', 'overflow');
    // The ceiling reply is its OWN kind — it must never come back as { kind: 'ready' } where
    // the caller would re-classify and re-coach it instead of sending it. (The original bug.)
    expect(result).toEqual({
      kind: 'rate_limited',
      text: expect.stringContaining('take these one at a time'),
    });
  });

  it('handles single message', async () => {
    const promise = coalescer.coalesce('123', 'only message');

    jest.advanceTimersByTime(3001);
    expect(await promise).toEqual({ kind: 'ready', text: 'only message' });
  });

  it('burst resolves exactly once (no duplicate coach turns)', async () => {
    const p1 = coalescer.coalesce('123', 'msg1');
    const p2 = coalescer.coalesce('123', 'msg2');
    const p3 = coalescer.coalesce('123', 'msg3');

    expect(await p2).toEqual({ kind: 'coalesced' });
    expect(await p3).toEqual({ kind: 'coalesced' });

    jest.advanceTimersByTime(3001);
    expect(await p1).toEqual({ kind: 'ready', text: 'msg1\nmsg2\nmsg3' });
  });
});
