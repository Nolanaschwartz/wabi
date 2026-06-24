import { streamSession, splitSendable, SynthSocket, SessionInit } from './streaming-synth';

const INIT: SessionInit = { voice: 'v', language: 'English', sampleRate: 24000, speed: 1.1 };
const tick = () => new Promise((r) => setTimeout(r, 0));

// A fake server-side of the socket: captures what the client sent, lets the test push messages/close.
function fakeSocket() {
  let onMsg: ((d: any) => void) | undefined;
  let onClose: (() => void) | undefined;
  let onErr: ((e: Error) => void) | undefined;
  const sent: string[] = [];
  let closes = 0;
  const sock: SynthSocket = {
    send: (d) => sent.push(String(d)),
    onMessage: (cb) => (onMsg = cb),
    onClose: (cb) => (onClose = cb),
    onError: (cb) => (onErr = cb),
    close: () => {
      closes++;
      onClose?.(); // mimic a real WS firing 'close'
    },
  };
  return {
    sock,
    sent,
    closes: () => closes,
    emit: (d: any) => onMsg?.(d),
    emitClose: () => onClose?.(),
    emitError: (e: Error) => onErr?.(e),
  };
}

const pcmFrame = (...vals: number[]) => Buffer.from(Int16Array.from(vals).buffer);
const controls = (sent: string[]) => sent.map((s) => JSON.parse(s));

describe('splitSendable', () => {
  it('flushes up to the last word/clause boundary, keeping the partial', () => {
    expect(splitSendable('Hello wor')).toEqual(['Hello ', 'wor']);
    expect(splitSendable('Hello, world')).toEqual(['Hello, ', 'world']);
    expect(splitSendable('done.')).toEqual(['done.', '']);
    expect(splitSendable('noboundary')).toEqual(['', 'noboundary']);
  });
});

describe('streamSession', () => {
  it('sends init -> word-aligned text -> end, and yields PCM, then closes', async () => {
    const fake = fakeSocket();
    async function* text() {
      yield 'Hello there. ';
      yield 'How ar';
      yield 'e you?';
    }
    const out: Int16Array[] = [];
    const gen = streamSession(() => fake.sock, INIT, text());
    const collect = (async () => {
      for await (const f of gen) out.push(f);
    })();

    await tick(); // init + text frames flow
    fake.emit(pcmFrame(1, 2, 3));
    await tick();
    fake.emitClose();
    await collect;

    const msgs = controls(fake.sent);
    expect(msgs[0]).toMatchObject({ type: 'init', voice: 'v', sample_rate: 24000, speed: 1.1 });
    const sentText = msgs.filter((m) => m.type === 'text').map((m) => m.text).join('');
    expect(sentText).toBe('Hello there. How are you?'); // reassembled losslessly, never mid-word
    expect(msgs.at(-1)).toEqual({ type: 'end' });
    expect(out).toHaveLength(1);
    expect(Array.from(out[0])).toEqual([1, 2, 3]);
  });

  it('carries an odd trailing byte across binary frames', async () => {
    const fake = fakeSocket();
    async function* text() {
      yield 'hi.';
    }
    const out: Int16Array[] = [];
    const gen = streamSession(() => fake.sock, INIT, text());
    const collect = (async () => {
      for await (const f of gen) out.push(f);
    })();
    await tick();
    fake.emit(Buffer.from([0x01])); // 1 byte — no full sample yet
    fake.emit(Buffer.from([0x00, 0x02, 0x00])); // completes sample 1, plus sample 2
    await tick();
    fake.emitClose();
    await collect;
    const flat = out.flatMap((f) => Array.from(f));
    expect(flat).toEqual([1, 2]); // 0x0001 then 0x0002, odd byte carried
  });

  it('throws on a server error frame', async () => {
    const fake = fakeSocket();
    async function* text() {
      yield 'hi';
    }
    const gen = streamSession(() => fake.sock, INIT, text());
    const collect = (async () => {
      for await (const _ of gen) void _;
    })();
    await tick();
    fake.emit(JSON.stringify({ type: 'error', message: 'boom' }));
    await expect(collect).rejects.toThrow(/boom/);
  });

  it('closes the socket on abort', async () => {
    const fake = fakeSocket();
    const ctrl = new AbortController();
    async function* text() {
      yield 'hi ';
      await new Promise<void>(() => {}); // never resolves — simulates a slow LLM
    }
    const gen = streamSession(() => fake.sock, INIT, text(), ctrl.signal);
    const collect = (async () => {
      try {
        for await (const _ of gen) void _;
      } catch {
        /* ignore */
      }
    })();
    await tick();
    ctrl.abort();
    await tick();
    await collect; // must not hang even though the text source never completes
    expect(fake.closes()).toBeGreaterThan(0);
  });
});
