import type { AgentConfig } from './agent.config';

// synthesizeSession is thin glue over streamSession (the wire protocol lives in streaming-synth.ts, tested
// there). Mock it so we can assert the adapter wires the config-driven init (voice/speed/sampleRate).
jest.mock('./streaming-synth', () => ({
  streamSession: jest.fn(() => (async function* () {})()),
  wsSocket: jest.fn(() => ({}) as any),
}));

import { createOpenAiPipeline } from './openai-speech';
import { streamSession } from './streaming-synth';

const cfg: AgentConfig = {
  stt: { url: 'http://stt', model: 'whisper' },
  llm: { url: 'http://llm', model: 'm', maxTokens: 160 },
  tts: { url: 'http://tts', model: 't', voice: 'v', speed: 1.1 },
  systemPrompt: 'sp',
};

const closedStream = () =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  });

const once = (s: string) =>
  (async function* () {
    yield s;
  })();

describe('openai-speech', () => {
  const origFetch = global.fetch;
  let bodies: any[];

  beforeEach(() => {
    bodies = [];
    (streamSession as jest.Mock).mockClear();
    global.fetch = jest.fn(async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, body: closedStream() } as any;
    }) as any;
  });
  afterEach(() => {
    global.fetch = origFetch;
  });

  it('LLM request carries max_tokens from config', async () => {
    const p = createOpenAiPipeline(cfg);
    for await (const _ of p.responder.respondStream([{ role: 'user', content: 'hi' }])) {
      /* drain */
    }
    expect(bodies[0].max_tokens).toBe(160);
  });

  it('synthesizeSession wires the config-driven init (voice/speed/sampleRate)', async () => {
    const p = createOpenAiPipeline(cfg);
    for await (const _ of p.synthesizer.synthesizeSession(once('hi'))) {
      /* drain */
    }
    expect(streamSession).toHaveBeenCalledTimes(1);
    const init = (streamSession as jest.Mock).mock.calls[0][1];
    expect(init).toMatchObject({ voice: 'v', speed: 1.1, sampleRate: 24000, language: 'Auto' });
  });
});
