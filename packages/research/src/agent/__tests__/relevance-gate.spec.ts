// relevanceGate is now a caller of @wabi/shared/generate: build prompt -> generate -> map result.
// The MECHANISM (provider resolution, ai client, the call) moved into generate; what stays here and
// is tested is the gate's DOMAIN logic — the "no" parse, topic/scope wording, and its fail-OPEN policy
// (error/empty -> keep).
jest.mock('@wabi/shared/generate', () => ({ generate: jest.fn() }));

import { relevanceGate } from '../relevance-gate';
import { SCOPE_FRAGMENT } from '../scope-policy';

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
    const r = await relevanceGate('Emotion regulation reduced tilt in competitive players.', 'tilt');
    expect(r.keep).toBe(true);
    expect(r.tokens).toBe(5);
  });

  it('drops an off-topic abstract', async () => {
    generate.mockResolvedValue(reply('no', 4));
    expect((await relevanceGate('A study of knee cartilage repair.', 'tilt')).keep).toBe(false);
  });

  it('keeps a transferable-mechanism abstract for the topic', async () => {
    generate.mockResolvedValue(reply('yes', 5));
    expect((await relevanceGate('Implementation intentions improved habit follow-through.', 'motivation')).keep).toBe(true);
  });

  it('drops a supplement/clinical abstract at the gate', async () => {
    generate.mockResolvedValue(reply('no', 4));
    expect((await relevanceGate('Vitamin D supplementation improved mood.', 'mood')).keep).toBe(false);
  });

  it('prompts with the run topic and the shared scope fragment', async () => {
    generate.mockResolvedValue(reply('yes', 5));
    await relevanceGate('abstract body', 'rumination');
    const prompt: string = generate.mock.calls[0][1].prompt;
    expect(prompt).toContain('rumination');
    expect(prompt).toContain(SCOPE_FRAGMENT);
  });

  it('uses role "research-triage", opts out of retry-on-empty, and is deterministic (temp 0)', async () => {
    generate.mockResolvedValue(reply('yes', 5));
    await relevanceGate('x', 'topic');
    expect(generate.mock.calls[0][0]).toBe('research-triage');
    expect(generate.mock.calls[0][1].retryOnEmpty).toBeUndefined();
    expect(generate.mock.calls[0][1].temperature).toBe(0); // deterministic binary gate
  });

  it('fails open (keep) on provider error so coverage is not silently lost', async () => {
    generate.mockRejectedValue(new Error('timeout'));
    expect((await relevanceGate('anything', 'topic')).keep).toBe(true);
  });

  it('fails open (keep) on EMPTY output — a reasoning model starved by the token cap returns ""', async () => {
    generate.mockResolvedValue(reply('', 480));
    const r = await relevanceGate('Emotion regulation reduced tilt in competitive players.', 'tilt');
    expect(r.keep).toBe(true);
    expect(r.tokens).toBe(480);
  });

  it('requests an output budget large enough for a reasoning model to actually answer', async () => {
    generate.mockResolvedValue(reply('yes', 5));
    await relevanceGate('x', 'topic');
    expect(generate.mock.calls[0][1].maxOutputTokens).toBeGreaterThanOrEqual(1000);
  });
});
