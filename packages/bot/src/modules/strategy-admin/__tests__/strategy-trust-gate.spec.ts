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

  it('routes research-agent draft to queue even when allowlisted + safe + faithful (ADR-0033 override)', async () => {
    const { generateText } = require('ai') as { generateText: jest.Mock };
    generateText
      .mockResolvedValueOnce({ text: 'safe' })
      .mockResolvedValueOnce({ text: 'faithful' });

    const result = await gate.evaluate({
      id: '1',
      title: 'PMR',
      technique: 'Tense and release major muscle groups for 5 min',
      source: 'PubMed',
      evidence: 'peer-reviewed: RCT',
      sourceText: 'progressive muscle relaxation reduced state anxiety',
      sourceUrl: 'https://pubmed.ncbi.nlm.nih.gov/12345',
      trustLevel: 'research-agent',
      status: 'draft',
    });

    expect(result.decision).toBe('queue'); // NOT 'publish'
  });

  it('rejects a research-agent draft that fails safety (never reaches the reviewer)', async () => {
    const { generateText } = require('ai') as { generateText: jest.Mock };
    generateText.mockResolvedValueOnce({ text: 'unsafe' });

    const result = await gate.evaluate({
      id: '1',
      title: 'X',
      technique: 'Y',
      source: 'PubMed',
      evidence: 'peer-reviewed: RCT',
      sourceUrl: 'https://pubmed.ncbi.nlm.nih.gov/12345',
      trustLevel: 'research-agent',
      status: 'draft',
    });

    expect(result.decision).toBe('reject');
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

  it('requests enough output budget for a reasoning model (small cap returns empty -> wrongly rejects)', async () => {
    const { generateText } = require('ai') as { generateText: jest.Mock };
    generateText
      .mockResolvedValueOnce({ text: 'safe' })
      .mockResolvedValueOnce({ text: 'faithful' });

    await gate.evaluate({
      id: '1', title: 'X', technique: 'Y', source: 'PubMed', evidence: 'peer-reviewed: RCT',
      sourceUrl: 'https://pubmed.ncbi.nlm.nih.gov/12345', trustLevel: 'research-agent', status: 'draft',
    });

    expect(generateText.mock.calls[0][0].maxOutputTokens).toBeGreaterThanOrEqual(1000);
  });

  it('accepts a clean answer with trailing text ("safe.") via startsWith, not strict equality', async () => {
    const { generateText } = require('ai') as { generateText: jest.Mock };
    generateText
      .mockResolvedValueOnce({ text: 'safe.' })
      .mockResolvedValueOnce({ text: 'faithful\n' });

    const result = await gate.evaluate({
      id: '1', title: 'X', technique: 'Y', source: 'PubMed', evidence: 'peer-reviewed: RCT',
      sourceUrl: 'https://pubmed.ncbi.nlm.nih.gov/12345', trustLevel: 'research-agent', status: 'draft',
    });

    expect(result.decision).toBe('queue');
  });

  it('fails closed (reject) on EMPTY output — a reasoning model starved by the cap', async () => {
    const { generateText } = require('ai') as { generateText: jest.Mock };
    generateText.mockResolvedValueOnce({ text: '' });

    const result = await gate.evaluate({
      id: '1', title: 'X', technique: 'Y', source: 'PubMed', evidence: 'peer-reviewed: RCT',
      sourceUrl: 'https://pubmed.ncbi.nlm.nih.gov/12345', trustLevel: 'research-agent', status: 'draft',
    });

    expect(result.decision).toBe('reject');
  });
});
