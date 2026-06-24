// Drain signal for barge-in during the playout tail (slice 6).
//
// The TTS runs faster than realtime, so respond() finishes RECEIVING the reply (its .finally fires)
// while the bridge is still PLAYING the tail out of outBuf for up to a few seconds. The turn detector
// must stay suppressed for that whole tail, or user speech in the tail starts a NEW turn instead of
// barging — the assistant talks over the user uninterruptibly. So the agent gates setSuppressed(false)
// on whenDrained(): a promise this tracker resolves only once playout has actually drained.
//
// This owns the drain STATE on a clean footing, deliberately separate from the bridge's temporary
// `logPlayout` diagnostics (a later cleanup slice removes those — it must not touch drain correctness).
//
// FAIL-OPEN is the whole point: a missed drain signal that leaves the detector permanently suppressed
// (deaf) is worse than the bug being fixed. So whenDrained() always resolves — on real drain, and
// immediately if armed after a barge/clear() or teardown. The agent layers a safety timeout on top.
export class PlayoutDrain {
  private waiters: Array<() => void> = [];
  private done = false; // true once teardown'd: every future whenDrained() resolves at once

  // Called by the pacer each tick with the current playout state. `pendingReal` = real assistant audio
  // still queued anywhere (outBuf has >= a frame, or real frames the player hasn't consumed yet). When
  // it goes false, the tail has played out — release anyone waiting on drain.
  update(pendingReal: boolean): void {
    if (!pendingReal) this.flush();
  }

  // Resolves when playout has drained. If already drained (or torn down), resolves on the next tick so
  // callers always get async settle semantics. Never rejects — fail-open.
  whenDrained(): Promise<void> {
    if (this.done) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  // Barge/clear(): the queued audio was just dropped, so playout is drained by definition. Release
  // waiters; future whenDrained() calls (a fresh reply's gate) start waiting again.
  clear(): void {
    this.flush();
  }

  // Session teardown: from here every whenDrained() resolves immediately, so a gate armed during
  // shutdown can never strand the detector suppressed.
  close(): void {
    this.done = true;
    this.flush();
  }

  private flush(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const resolve of w) resolve();
  }
}
