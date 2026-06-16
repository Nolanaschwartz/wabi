import { RateLimiter } from '../rate-limiter';

describe('RateLimiter', () => {
  it('serializes calls so two back-to-back run at least minIntervalMs apart', async () => {
    const limiter = new RateLimiter(50);
    const stamps: number[] = [];
    await Promise.all([
      limiter.schedule(async () => stamps.push(Date.now())),
      limiter.schedule(async () => stamps.push(Date.now())),
    ]);
    expect(stamps).toHaveLength(2);
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(45);
  });

  it('returns the task result', async () => {
    const limiter = new RateLimiter(1);
    expect(await limiter.schedule(async () => 42)).toBe(42);
  });
});
