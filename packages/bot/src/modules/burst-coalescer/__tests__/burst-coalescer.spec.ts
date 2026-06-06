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
    const result = await promise;
    expect(result).toBe('hello\nworld');
  });

  it('returns null for interim messages (no dangling promises)', async () => {
    const promise = coalescer.coalesce('123', 'hello');
    const interim = coalescer.coalesce('123', 'world');

    expect(interim).toBeNull();
    jest.advanceTimersByTime(3001);
    const result = await promise;
    expect(result).toBe('hello\nworld');
  });

  it('cancels pending turn on crisis', async () => {
    const promise = coalescer.coalesce('123', 'hello');

    coalescer.cancel('123');
    jest.advanceTimersByTime(3001);
    const result = await promise;
    expect(result).toBe('__canceled__');
  });

  it('returns caring message over hourly ceiling', async () => {
    for (let i = 0; i < 30; i++) {
      const promise = coalescer.coalesce('123', 'msg');
      jest.advanceTimersByTime(3001);
      await promise;
    }

    const result = await coalescer.coalesce('123', 'overflow');
    expect(result).toContain('take these one at a time');
  });

  it('handles single message', async () => {
    const promise = coalescer.coalesce('123', 'only message');

    jest.advanceTimersByTime(3001);
    const result = await promise;
    expect(result).toBe('only message');
  });

  it('burst resolves exactly once (no duplicate coach turns)', async () => {
    const p1 = coalescer.coalesce('123', 'msg1');
    const p2 = coalescer.coalesce('123', 'msg2');
    const p3 = coalescer.coalesce('123', 'msg3');

    expect(p2).toBeNull();
    expect(p3).toBeNull();

    jest.advanceTimersByTime(3001);
    const result = await p1;
    expect(result).toBe('msg1\nmsg2\nmsg3');
  });
});
