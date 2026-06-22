/**
 * Depth-1 lookahead for sentence-by-sentence TTS.
 *
 * An LLM reply is split into sentences; each is synthesized to a streamed PCM frame
 * iterable and played in order. Serial synth+playback leaves a ~0.6s first-frame gap at
 * every sentence boundary. This module hides that gap by starting synthesis of sentence
 * N+1 (and buffering its frames) while sentence N is still being consumed, so N+1 is
 * ready the instant N finishes. Depth is fixed at 1.
 */

export type SynthFn = (text: string, signal: AbortSignal) => AsyncIterable<Int16Array>;

/** A minimal async queue: a producer pushes frames / a terminal error; a consumer awaits them. */
class FrameBuffer {
  private readonly frames: Int16Array[] = [];
  private error: unknown;
  private closed = false;
  private waiter: (() => void) | null = null;

  push(frame: Int16Array): void {
    this.frames.push(frame);
    this.wake();
  }

  /** Close the buffer; if `err` is set it is rethrown after buffered frames drain. */
  close(err?: unknown): void {
    if (err !== undefined) this.error = err;
    this.closed = true;
    this.wake();
  }

  async *stream(): AsyncIterableIterator<Int16Array> {
    for (;;) {
      while (this.frames.length > 0) {
        yield this.frames.shift() as Int16Array;
      }
      if (this.closed) {
        if (this.error !== undefined) throw this.error;
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  private wake(): void {
    const w = this.waiter;
    if (w) {
      this.waiter = null;
      w();
    }
  }
}

/**
 * Start synthesizing one sentence: kicks off a background drain loop that pulls frames from
 * `synth(text, signal)` into a buffer, capturing any thrown error (whether synth throws while
 * constructing the iterable or its iterator rejects mid-stream) so it surfaces only when the
 * returned stream is consumed — never as an unhandled rejection. Returns the buffered frame-stream.
 */
function startJob(text: string, synth: SynthFn, signal: AbortSignal): AsyncIterable<Int16Array> {
  const buffer = new FrameBuffer();
  void (async () => {
    try {
      for await (const frame of synth(text, signal)) buffer.push(frame);
      buffer.close();
    } catch (err) {
      buffer.close(err ?? new Error('synth failed'));
    }
  })();
  return buffer.stream();
}

/**
 * Yields, in input order, one PCM frame-stream per input sentence. Starts synthesizing the NEXT
 * sentence (depth-1 lookahead) while the current sentence's frame-stream is still being consumed,
 * buffering the lookahead's frames in memory. Stops yielding once `cancelled()` returns true and
 * relies on `signal` (already shared with the synth calls) to abort in-flight synthesis.
 */
export async function* prefetchSynth(
  sentences: AsyncIterable<string>,
  synth: SynthFn,
  signal: AbortSignal,
  cancelled: () => boolean,
): AsyncGenerator<AsyncIterable<Int16Array>> {
  const iter = sentences[Symbol.asyncIterator]();

  // Pulls the next sentence text and, once it lands, starts its synth — returning the buffered
  // stream. A pending promise without blocking the caller when the text isn't ready yet.
  const nextJob = async (): Promise<AsyncIterable<Int16Array> | undefined> => {
    const r = await iter.next();
    return r.done ? undefined : startJob(r.value, synth, signal);
  };

  let curP = nextJob();
  for (;;) {
    const cur = await curP;
    if (!cur) return;

    // Begin fetching the next sentence (and its synth, once available) concurrently with the
    // yield below. This promise stays pending without delaying the current stream when the next
    // sentence text isn't ready yet.
    const aheadP = nextJob();

    yield cur;

    if (cancelled()) {
      // Drop any buffered-but-unconsumed lookahead. The caller aborts `signal` separately, which
      // unblocks the background drain; we just ensure the ahead promise can't leak a rejection.
      aheadP.catch(() => undefined);
      return;
    }

    curP = aheadP;
  }
}
