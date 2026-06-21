import { prefetchSynth, type SynthFn } from './synth-prefetcher';

/** A never-resolving signal stand-in; these tests never actually abort. */
const dummySignal = (): AbortSignal => new AbortController().signal;

/** Resolve on the next microtask, to interleave concurrent async work deterministically. */
const tick = (): Promise<void> => Promise.resolve();

/** A manually-released gate. */
function makeGate(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((res) => {
    release = res;
  });
  return { wait, release };
}

/** An async-iterable sentence source whose second item is withheld behind a gate. */
function gatedSentences(
  first: string,
  rest: string[],
  gate: Promise<void>,
): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      yield first;
      await gate;
      for (const s of rest) yield s;
    },
  };
}

function frame(n: number): Int16Array {
  return Int16Array.of(n);
}

describe('prefetchSynth', () => {
  const rejections: unknown[] = [];
  const onRejection = (e: unknown) => rejections.push(e);

  beforeAll(() => process.on('unhandledRejection', onRejection));
  afterAll(() => process.off('unhandledRejection', onRejection));
  beforeEach(() => {
    rejections.length = 0;
  });
  afterEach(async () => {
    // Let any pending microtasks/timers flush so leaked rejections surface.
    await new Promise((r) => setTimeout(r, 0));
    expect(rejections).toEqual([]);
  });

  async function* fromArray<T>(items: T[]): AsyncIterable<T> {
    for (const i of items) yield i;
  }

  async function drain(stream: AsyncIterable<Int16Array>): Promise<number[]> {
    const out: number[] = [];
    for await (const f of stream) out.push(f[0]);
    return out;
  }

  it('preserves order: one frame-stream per sentence, frames in arrival order', async () => {
    const synth: SynthFn = async function* (text) {
      // Two frames per sentence, encoding sentence index + frame index.
      const base = text.charCodeAt(0);
      yield frame(base * 10 + 0);
      yield frame(base * 10 + 1);
    };

    const sentences = fromArray(['A', 'B', 'C']);
    const collected: number[][] = [];
    for await (const stream of prefetchSynth(sentences, synth, dummySignal(), () => false)) {
      collected.push(await drain(stream));
    }

    expect(collected).toEqual([
      ['A'.charCodeAt(0) * 10, 'A'.charCodeAt(0) * 10 + 1],
      ['B'.charCodeAt(0) * 10, 'B'.charCodeAt(0) * 10 + 1],
      ['C'.charCodeAt(0) * 10, 'C'.charCodeAt(0) * 10 + 1],
    ]);
  });

  it('depth-1 overlap: synth(N+1) is invoked before sentence N is fully consumed', async () => {
    const invokeOrder: string[] = [];
    // synth yields 3 frames, awaiting a microtask between each so consumption is "slow".
    const synth: SynthFn = async function* (text) {
      invokeOrder.push(text);
      for (let i = 0; i < 3; i++) {
        await tick();
        yield frame(i);
      }
    };

    const sentences = fromArray(['first', 'second']);
    const gen = prefetchSynth(sentences, synth, dummySignal(), () => false);

    const { value: stream1 } = await gen.next();
    // Consume the first sentence's frames slowly, asserting the second synth started.
    const it = (stream1 as AsyncIterable<Int16Array>)[Symbol.asyncIterator]();
    let sawSecondDuringFirst = false;
    for (;;) {
      const r = await it.next();
      if (r.done) break;
      await tick();
      await tick();
      if (invokeOrder.includes('second')) sawSecondDuringFirst = true;
    }

    expect(sawSecondDuringFirst).toBe(true);
    expect(invokeOrder).toEqual(['first', 'second']);

    // Drain the rest to finish cleanly.
    const { value: stream2 } = await gen.next();
    await drain(stream2 as AsyncIterable<Int16Array>);
    await gen.next();
  });

  it('first sentence is not delayed by a slow/withheld next sentence', async () => {
    const gate = makeGate();
    const synth: SynthFn = async function* (text) {
      yield frame(text.charCodeAt(0));
    };

    const sentences = gatedSentences('One.', ['Two.'], gate.wait);
    const gen = prefetchSynth(sentences, synth, dummySignal(), () => false);

    // Sentence 1 must be fully consumable before the gate is released.
    const { value: stream1 } = await gen.next();
    const frames1 = await drain(stream1 as AsyncIterable<Int16Array>);
    expect(frames1).toEqual(['One.'.charCodeAt(0)]);

    // Second sentence is still withheld; releasing the gate lets it flow.
    gate.release();
    const { value: stream2 } = await gen.next();
    const frames2 = await drain(stream2 as AsyncIterable<Int16Array>);
    expect(frames2).toEqual(['Two.'.charCodeAt(0)]);

    const end = await gen.next();
    expect(end.done).toBe(true);
  });

  it('propagates an error when the synth iterator rejects partway', async () => {
    const boom = new Error('synth blew up');
    const synth: SynthFn = (text) => ({
      async *[Symbol.asyncIterator]() {
        if (text === 'bad') {
          yield frame(1);
          throw boom;
        }
        yield frame(text.charCodeAt(0));
      },
    });

    const sentences = fromArray(['ok', 'bad']);
    const gen = prefetchSynth(sentences, synth, dummySignal(), () => false);

    const { value: stream1 } = await gen.next();
    expect(await drain(stream1 as AsyncIterable<Int16Array>)).toEqual(['ok'.charCodeAt(0)]);

    const { value: stream2 } = await gen.next();
    await expect(drain(stream2 as AsyncIterable<Int16Array>)).rejects.toThrow('synth blew up');

    await gen.next();
  });

  it('propagates an error when synth throws synchronously constructing the iterable', async () => {
    const boom = new Error('cannot construct');
    const synth: SynthFn = (text) => {
      if (text === 'bad') throw boom;
      return (async function* () {
        yield frame(text.charCodeAt(0));
      })();
    };

    const sentences = fromArray(['ok', 'bad']);
    const gen = prefetchSynth(sentences, synth, dummySignal(), () => false);

    const { value: stream1 } = await gen.next();
    expect(await drain(stream1 as AsyncIterable<Int16Array>)).toEqual(['ok'.charCodeAt(0)]);

    const { value: stream2 } = await gen.next();
    await expect(drain(stream2 as AsyncIterable<Int16Array>)).rejects.toThrow('cannot construct');

    await gen.next();
  });

  it('cancellation: stops yielding and drops buffered lookahead after cancel', async () => {
    const invoked: string[] = [];
    const synth: SynthFn = async function* (text) {
      invoked.push(text);
      yield frame(text.charCodeAt(0));
    };

    let cancel = false;
    const sentences = fromArray(['x', 'y', 'z']);
    const yielded: string[] = [];
    for await (const stream of prefetchSynth(sentences, synth, dummySignal(), () => cancel)) {
      const frames = await drain(stream);
      yielded.push(String.fromCharCode(frames[0]));
      // Cancel after consuming the first sentence.
      cancel = true;
    }

    expect(yielded).toEqual(['x']);
    // 'z' must never be synthesized; 'y' may have been prefetched but is never yielded.
    expect(yielded).not.toContain('y');
    expect(invoked).not.toContain('z');
  });
});
