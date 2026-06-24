import { createOpenAiPipeline } from './openai-speech';
import type { AgentConfig } from './agent.config';

// Slices 05/09: the streaming request bodies must carry the config-driven max_tokens (reply-length cap)
// and speed (voice pacing). Mock fetch to capture the body and return an immediately-closed stream.
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

describe('openai-speech streaming request bodies', () => {
  const origFetch = global.fetch;
  let bodies: any[];

  beforeEach(() => {
    bodies = [];
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

  it('TTS request carries speed from config', async () => {
    const p = createOpenAiPipeline(cfg);
    for await (const _ of p.synthesizer.synthesizeStream('hi')) {
      /* drain */
    }
    expect(bodies[0].speed).toBe(1.1);
  });
});
