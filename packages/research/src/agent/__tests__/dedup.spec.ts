jest.mock('@ai-sdk/openai', () => ({ createOpenAI: jest.fn(() => jest.fn(() => ({}))) }));
jest.mock('ai', () => ({ generateText: jest.fn() }));
jest.mock('@wabi/shared', () => ({ getProvider: jest.fn(() => ({ baseUrl: 'http://t', model: 'm', apiKey: 'k' })) }));

import { isDuplicateInRun } from '../dedup';
import { Candidate } from '../../types';

const mk = (title: string, technique: string): Candidate => ({
  title, technique, sourceText: 's', evidence: 'e', sourceUrl: 'u',
  source: 'PubMed', sourceId: 'PMID:x', sourceKind: 'pubmed', trustLevel: 'research-agent',
});

describe('isDuplicateInRun', () => {
  const { generateText } = require('ai') as { generateText: jest.Mock };
  beforeEach(() => jest.clearAllMocks());

  it('distinct when there is nothing kept yet (no LLM call)', async () => {
    const r = await isDuplicateInRun(mk('Box Breathing', 'inhale hold exhale'), []);
    expect(r.duplicate).toBe(false);
    expect(generateText).not.toHaveBeenCalled();
  });

  it('duplicate via lexical overlap without an LLM call', async () => {
    const kept = [mk('Progressive muscle relaxation', 'tense and release major muscle groups')];
    const r = await isDuplicateInRun(mk('Progressive muscle relaxation', 'tense and release major muscle groups'), kept);
    expect(r.duplicate).toBe(true);
    expect(generateText).not.toHaveBeenCalled();
  });

  it('uses the LLM to confirm an ambiguous middle case', async () => {
    generateText.mockResolvedValue({ text: 'same', usage: { totalTokens: 6 } });
    const kept = [mk('Box Breathing', 'inhale 4 hold 4 exhale 4 to calm down')];
    const r = await isDuplicateInRun(mk('Square breathing drill', 'four-count breathing to reduce arousal'), kept);
    expect(generateText).toHaveBeenCalled();
    expect(r.duplicate).toBe(true);
  });

  it('requests an output budget large enough for a reasoning model to answer the ambiguous case', async () => {
    generateText.mockResolvedValue({ text: 'same', usage: { totalTokens: 6 } });
    const kept = [mk('Box Breathing', 'inhale 4 hold 4 exhale 4 to calm down')];
    await isDuplicateInRun(mk('Square breathing drill', 'four-count breathing to reduce arousal'), kept);
    expect(generateText.mock.calls[0][0].maxOutputTokens).toBeGreaterThanOrEqual(1000);
  });
});
