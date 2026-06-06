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

  it('routes session-mined draft to queue regardless of source', async () => {
    const result = await gate.evaluate({
      id: '1',
      title: 'Test',
      technique: 'Test technique',
      source: 'APA',
      evidence: 'Test evidence',
      sourceUrl: 'https://apa.org/test',
      trustLevel: 'session-mined',
      status: 'draft',
    });

    expect(result.decision).toBe('queue');
    expect(result.reason).toContain('Session-mined');
  });

  it('queues non-allowlisted source', async () => {
    const result = await gate.evaluate({
      id: '1',
      title: 'Test',
      technique: 'Test technique',
      source: 'Test source',
      evidence: 'Test evidence',
      sourceUrl: 'https://example.com',
      trustLevel: 'community',
      status: 'draft',
    });

    expect(result.decision).toBe('queue');
    expect(result.reason).toContain('not allowlisted');
  });

  it('auto-publishes allowlisted source with safe + faithful technique', async () => {
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

    expect(result.decision).toBe('publish');
  });

  it('rejects allowlisted source with unsafe technique', async () => {
    const { generateText } = require('ai') as {
      generateText: jest.Mock;
    };
    generateText.mockResolvedValueOnce({ text: 'unsafe' });

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

    expect(result.decision).toBe('reject');
    expect(result.reason).toContain('safety');
  });

  it('rejects allowlisted source with unfaithful technique', async () => {
    const { generateText } = require('ai') as {
      generateText: jest.Mock;
    };
    generateText
      .mockResolvedValueOnce({ text: 'safe' })
      .mockResolvedValueOnce({ text: 'unfaithful' });

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

    expect(result.decision).toBe('reject');
    expect(result.reason).toContain('faithful');
  });

  it('includes source text in faithfulness check', async () => {
    const { generateText } = require('ai') as {
      generateText: jest.Mock;
    };
    generateText
      .mockResolvedValueOnce({ text: 'safe' })
      .mockResolvedValueOnce({ text: 'faithful' });

    await gate.evaluate({
      id: '1',
      title: 'Test',
      technique: 'Test technique',
      source: 'APA',
      evidence: 'Test evidence',
      sourceText: 'CBT is effective for anxiety disorders.',
      sourceUrl: 'https://apa.org/test',
      trustLevel: 'allowlisted',
      status: 'draft',
    });

    expect(generateText).toHaveBeenCalledTimes(2);
    const faithfulnessCall = generateText.mock.calls[1][0];
    expect(faithfulnessCall.prompt).toContain('Source Text:');
    expect(faithfulnessCall.prompt).toContain('CBT is effective');
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

  it('shouldQuarantine returns true at threshold', () => {
    expect(gate.shouldQuarantine(3)).toBe(true);
    expect(gate.shouldQuarantine(2)).toBe(false);
    expect(gate.shouldQuarantine(0)).toBe(false);
  });

  it('fails closed on provider error', async () => {
    const { generateText } = require('ai') as {
      generateText: jest.Mock;
    };
    generateText.mockRejectedValueOnce(new Error('timeout'));

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

    expect(result.decision).toBe('reject');
  });
});
