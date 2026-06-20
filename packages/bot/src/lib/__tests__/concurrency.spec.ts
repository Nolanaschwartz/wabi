import { mapWithConcurrency } from '../concurrency';

describe('mapWithConcurrency', () => {
  it('returns results in input order', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it('processes the full set', async () => {
    const seen: number[] = [];
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('never runs more than `limit` workers at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];

    const items = Array.from({ length: 10 }, (_, i) => i);
    const promise = mapWithConcurrency(items, 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight--;
    });

    // Drain the queue one wave at a time, asserting the cap holds throughout.
    while (release.length > 0) {
      expect(inFlight).toBeLessThanOrEqual(3);
      release.shift()!();
      await Promise.resolve();
      await Promise.resolve();
    }
    await promise;

    expect(peak).toBe(3);
  });

  it('caps at the item count when limit exceeds it', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2], 10, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('returns [] for an empty input without invoking the worker', async () => {
    const worker = jest.fn();
    const out = await mapWithConcurrency([], 5, worker);
    expect(out).toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });

  it('rejects on the first worker rejection (Promise.all semantics)', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});
