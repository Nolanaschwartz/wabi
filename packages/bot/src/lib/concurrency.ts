// Tiny bounded fan-out helper. A background cron with an unbounded `Promise.all` pins one in-flight
// promise + closure per item in heap for the whole tick; a large cohort balloons heap and can spike
// downstream connections (Discord/Qdrant). This caps how many run at once while still processing the
// full set. ponytail: deliberately minimal — if we ever need cancellation, priorities, or per-task
// retries, swap this for `p-limit`/`p-queue` rather than growing it here.

/**
 * Run `worker` over every item with at most `limit` in flight at once. Like `Promise.all` it returns
 * each result in input order and REJECTS on the first worker rejection — so callers that must not let
 * one failure sink the batch should swallow per-item errors inside `worker` (the existing fan-outs
 * already wrap each item in try/catch, exactly as before).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const cap = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let next = 0;

  // `cap` workers pull from a shared cursor until the list is drained — steady-state concurrency is
  // exactly `cap`, no idle gaps between batch boundaries.
  const runners = Array.from({ length: cap }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });

  await Promise.all(runners);
  return results;
}
