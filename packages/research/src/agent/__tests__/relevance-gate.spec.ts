jest.mock('@ai-sdk/openai', () => ({ createOpenAI: jest.fn(() => jest.fn(() => ({}))) }));
jest.mock('ai', () => ({ generateText: jest.fn() }));
jest.mock('@wabi/shared', () => ({
  getProvider: jest.fn(() => ({ baseUrl: 'http://t', model: 'm', apiKey: 'k' })),
}));

import { relevanceGate } from '../relevance-gate';

describe('relevanceGate', () => {
  const { generateText } = require('ai') as { generateText: jest.Mock };
  beforeEach(() => jest.clearAllMocks());

  it('keeps an on-topic abstract', async () => {
    generateText.mockResolvedValue({ text: 'yes', usage: { totalTokens: 5 } });
    const r = await relevanceGate('Emotion regulation reduced tilt in competitive players.');
    expect(r.keep).toBe(true);
    expect(r.tokens).toBe(5);
  });

  it('drops an off-topic abstract', async () => {
    generateText.mockResolvedValue({ text: 'no', usage: { totalTokens: 4 } });
    expect((await relevanceGate('A study of knee cartilage repair.')).keep).toBe(false);
  });

  it('fails open (keep) on provider error so coverage is not silently lost', async () => {
    generateText.mockRejectedValue(new Error('timeout'));
    expect((await relevanceGate('anything')).keep).toBe(true);
  });

  it('fails open (keep) on EMPTY output — a reasoning model starved by the token cap returns ""', async () => {
    generateText.mockResolvedValue({ text: '', usage: { totalTokens: 480 } });
    const r = await relevanceGate('Emotion regulation reduced tilt in competitive players.');
    expect(r.keep).toBe(true);
    expect(r.tokens).toBe(480);
  });

  it('requests an output budget large enough for a reasoning model to actually answer', async () => {
    generateText.mockResolvedValue({ text: 'yes', usage: { totalTokens: 5 } });
    await relevanceGate('x');
    expect(generateText.mock.calls[0][0].maxOutputTokens).toBeGreaterThanOrEqual(1000);
  });
});
