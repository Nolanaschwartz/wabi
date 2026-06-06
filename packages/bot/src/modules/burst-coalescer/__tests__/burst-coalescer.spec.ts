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
});
