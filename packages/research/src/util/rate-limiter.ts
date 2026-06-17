/** Serializes async tasks with a minimum interval between starts — keeps NCBI under its rate cap
 * (3 req/s keyless) so a run can't get the IP blocked. */
export class RateLimiter {
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;

  constructor(private readonly minIntervalMs: number) {}

  schedule<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.last);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      return task();
    });
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }
}
