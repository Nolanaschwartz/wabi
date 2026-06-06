jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: jest.fn(() => jest.fn(() => ({}))),
}));

jest.mock('ai', () => ({
  generateText: jest.fn(),
}));

jest.mock('@wabi/shared', () => ({
  getProvider: jest.fn(() => ({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
  })),
}));

import { StrategyTrustGate } from '../strategy-trust-gate';

describe('StrategyTrustGate', () => {
  let gate: StrategyTrustGate;

  beforeEach(() => {
    jest.clearAllMocks();
    gate = new StrategyTrustGate();
  });

  it('rejects non-allowlisted source', async () => {
    const result = await gate.evaluate({
      id: '1',
      title: 'Test',
      technique: 'Test technique',
      source: 'Test source',
      evidence: 'Test evidence',
      sourceUrl: 'https://example.com',
      trustLevel: 'allowlisted',
      status: 'draft',
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toContain('not allowlisted');
  });

  it('auto-publishes allowlisted source with faithful technique', async () => {
    const { generateText } = require('ai') as {
      generateText: jest.Mock;
    };
    generateText
      .mockResolvedValueOnce({ text: 'safe' })
      .mockResolvedValueOnce({ text: 'faithful' });

    const result = await gate.evaluate({
      id: '1',
      title: 'Test',
      technique: 'Test technique',
      source: 'APA',
      evidence: 'Test evidence',
      sourceUrl: 'https://apa.org/test',
      trustLevel: 'allowlisted',
      status: 'draft',
    });

    expect(result.approved).toBe(true);
  });

  it('quarantines strategy', () => {
    const draft = {
      id: '1',
      title: 'Test',
      technique: 'Test technique',
      source: 'APA',
      evidence: 'Test evidence',
      sourceUrl: 'https://apa.org/test',
      trustLevel: 'allowlisted' as const,
      status: 'published' as const,
    };

    const quarantined = StrategyTrustGate.quarantine(draft);
    expect(quarantined.status).toBe('quarantined');
  });
});
