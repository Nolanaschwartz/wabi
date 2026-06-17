// relevanceGate is now a caller of @wabi/shared/generate: build prompt -> generate -> map result.
// The MECHANISM (provider resolution, ai client, the call) moved into generate; what stays here and
// is tested is the gate's DOMAIN logic — the "no" parse — and its fail-OPEN policy (error/empty -> keep).
jest.mock('@wabi/shared/generate', () => ({ generate: jest.fn() }));

import { relevanceGate } from '../relevance-gate';

describe('relevanceGate', () => {
  const { generate } = require('@wabi/shared/generate') as { generate: jest.Mock };
  // generate returns { text, usage, model, latencyMs }; the gate reads text + usage.totalTokens.
  const reply = (text: string, totalTokens?: number) => ({
    text,
    usage: totalTokens === undefined ? undefined : { totalTokens },
    model: 'm',
    latencyMs: 1,
  });
  beforeEach(() => jest.clearAllMocks());

  it('keeps an on-topic abstract', async () => {
    generate.mockResolvedValue(reply('yes', 5));
    const r = await relevanceGate('Emotion regulation reduced tilt in competitive players.');
    expect(r.keep).toBe(true);
    expect(r.tokens).toBe(5);
  });

  it('drops an off-topic abstract', async () => {
    generate.mockResolvedValue(reply('no', 4));
    expect((await relevanceGate('A study of knee cartilage repair.')).keep).toBe(false);
  });

  it('uses role "research-triage" and opts out of retry-on-empty', async () => {
    generate.mockResolvedValue(reply('yes', 5));
    await relevanceGate('x');
    expect(generate.mock.calls[0][0]).toBe('research-triage');
    expect(generate.mock.calls[0][1].retryOnEmpty).toBeUndefined();
  });

  it('fails open (keep) on provider error so coverage is not silently lost', async () => {
    generate.mockRejectedValue(new Error('timeout'));
    expect((await relevanceGate('anything')).keep).toBe(true);
  });

  it('fails open (keep) on EMPTY output — a reasoning model starved by the token cap returns ""', async () => {
    generate.mockResolvedValue(reply('', 480));
    const r = await relevanceGate('Emotion regulation reduced tilt in competitive players.');
    expect(r.keep).toBe(true);
    expect(r.tokens).toBe(480);
  });

  it('requests an output budget large enough for a reasoning model to actually answer', async () => {
    generate.mockResolvedValue(reply('yes', 5));
    await relevanceGate('x');
    expect(generate.mock.calls[0][1].maxOutputTokens).toBeGreaterThanOrEqual(1000);
  });
});
