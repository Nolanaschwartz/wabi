// Streaming-text TTS session (approach B — .scratch/streaming-tts-websocket/PRD.md). The turn loop feeds
// reply text in as the LLM produces it and reads ONE continuous PCM stream back, over one connection — so
// the whole reply is a single synthesis take (no seam, no tone jump, unlike the two-request approach C).
//
// WIRE PROTOCOL (the contract slice 3 implements on the Qwen3-TTS fork):
//   client -> server, JSON text frames:
//     {"type":"init","voice":<str>,"language":<str>,"format":"pcm","sample_rate":24000}
//     {"type":"text","text":<str>}        // sent repeatedly as deltas arrive (word/comma-aligned)
//     {"type":"end"}                      // utterance complete -> server runs the EOS flush
//   server -> client:
//     binary frames        = raw 16-bit LE mono PCM @ sample_rate
//     {"type":"error","message":<str>}    // JSON text frame on failure
//     (server closes the socket after the final PCM)

export interface SynthSocket {
  send(data: string | Uint8Array): void;
  onMessage(cb: (data: string | ArrayBuffer | Buffer) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (err: Error) => void): void;
  close(): void;
}

export interface SessionInit {
  voice: string;
  language: string;
  sampleRate: number;
}

// Flush buffered text up to the last word/clause boundary, keeping the trailing partial token so we never
// send a mid-word fragment (which the server could mis-tokenize). Returns [toSend, keep].
export function splitSendable(buf: string): [string, string] {
  // last whitespace OR punctuation boundary
  const m = buf.match(/^[\s\S]*[\s,;:.!?]/);
  if (!m) return ['', buf];
  const cut = m[0].length;
  return [buf.slice(0, cut), buf.slice(cut)];
}

function toInt16(buf: Buffer, carry: { b: Buffer }): Int16Array {
  const all = carry.b.length ? Buffer.concat([carry.b, buf]) : buf;
  const usable = all.length - (all.length % 2);
  carry.b = usable < all.length ? all.subarray(usable) : Buffer.alloc(0);
  const out = new Int16Array(usable / 2);
  for (let i = 0; i < out.length; i++) out[i] = all.readInt16LE(i * 2);
  return out;
}

// Drive the protocol over an (injectable) socket. Consumes `text` (LLM deltas) into `text` frames while
// yielding PCM frames the server streams back; sends `end` when `text` completes; aborts/closes on signal.
export async function* streamSession(
  openSocket: () => SynthSocket,
  init: SessionInit,
  text: AsyncIterable<string>,
  signal?: AbortSignal,
): AsyncIterable<Int16Array> {
  const sock = openSocket();
  const pcm: Int16Array[] = [];
  const carry = { b: Buffer.alloc(0) };
  let closed = false;
  let err: Error | null = null;
  let wake: (() => void) | null = null;
  const ping = () => {
    if (wake) {
      wake();
      wake = null;
    }
  };

  sock.onMessage((data) => {
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg?.type === 'error') err = new Error(`tts session: ${msg.message ?? 'error'}`);
      } catch {
        /* ignore non-JSON control */
      }
    } else {
      const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const frame = toInt16(b, carry);
      if (frame.length) pcm.push(frame);
    }
    ping();
  });
  sock.onClose(() => {
    closed = true;
    ping();
  });
  sock.onError((e) => {
    err = err ?? e;
    closed = true;
    ping();
  });

  const onAbort = () => {
    try {
      sock.close();
    } catch {
      /* already closing */
    }
  };
  signal?.addEventListener('abort', onAbort);

  // Producer: init -> text frames (word-aligned) -> end. Runs concurrently with the PCM yield loop.
  const pump = (async () => {
    sock.send(
      JSON.stringify({
        type: 'init',
        voice: init.voice,
        language: init.language,
        format: 'pcm',
        sample_rate: init.sampleRate,
      }),
    );
    let buf = '';
    for await (const delta of text) {
      if (signal?.aborted || closed) return;
      buf += delta;
      const [toSend, keep] = splitSendable(buf);
      buf = keep;
      if (toSend) sock.send(JSON.stringify({ type: 'text', text: toSend }));
    }
    if (signal?.aborted || closed) return;
    if (buf.trim()) sock.send(JSON.stringify({ type: 'text', text: buf }));
    sock.send(JSON.stringify({ type: 'end' }));
  })();
  // Fire-and-forget with its own handler. NOT awaited in finally: on abort the pump can be parked in the
  // text source's next() forever, and awaiting it would hang the generator's teardown.
  void pump.catch((e) => {
    err = err ?? e;
  });

  try {
    for (;;) {
      if (err) throw err;
      while (pcm.length) yield pcm.shift()!;
      if (closed) break;
      await new Promise<void>((r) => (wake = r));
    }
    if (err) throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      sock.close();
    } catch {
      /* ignore */
    }
  }
}

// Production transport: wrap Node's global WebSocket as a SynthSocket. Derive the ws(s):// URL from the
// configured TTS base url + the streaming path.
export function wsSocket(baseUrl: string, path = '/v1/audio/stream'): SynthSocket {
  const url = baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + path;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  return {
    send: (d) => ws.send(d),
    onMessage: (cb) => ws.addEventListener('message', (e) => cb(e.data)),
    onClose: (cb) => ws.addEventListener('close', () => cb()),
    onError: (cb) => ws.addEventListener('error', () => cb(new Error('tts websocket error'))),
    close: () => ws.close(),
  };
}
