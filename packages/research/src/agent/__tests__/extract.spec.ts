jest.mock('@ai-sdk/openai', () => ({ createOpenAI: jest.fn(() => jest.fn(() => ({}))) }));
jest.mock('ai', () => ({ generateText: jest.fn() }));
jest.mock('@wabi/shared', () => ({
  getProvider: jest.fn(() => ({ baseUrl: 'http://t', model: 'm', apiKey: 'k' })),
}));

import { extract, evidenceTag } from '../extract';
import { Paper } from '../../types';

const paper: Paper = {
  sourceId: 'PMID:1', sourceKind: 'pubmed', title: 'PMR and anxiety',
  abstract: 'In this trial, progressive muscle relaxation reduced state anxiety.',
  url: 'https://pubmed.ncbi.nlm.nih.gov/1', pubTypes: ['Randomized Controlled Trial'], isPreprint: false,
};

describe('evidenceTag', () => {
  it('tags peer-reviewed study types', () => {
    expect(evidenceTag(paper)).toBe('peer-reviewed: Randomized Controlled Trial');
  });
  it('tags observational when no high-tier type present', () => {
    expect(evidenceTag({ ...paper, pubTypes: ['Journal Article'] })).toBe('peer-reviewed: observational');
  });
  it('tags preprints', () => {
    expect(evidenceTag({ ...paper, isPreprint: true, pubTypes: [] })).toBe('preprint: not peer-reviewed');
  });
});

describe('extract', () => {
  const { generateText } = require('ai') as { generateText: jest.Mock };
  beforeEach(() => jest.clearAllMocks());

  it('returns a candidate whose sourceText is a verbatim substring of the body', async () => {
    generateText.mockResolvedValue({
      text: JSON.stringify({
        title: 'Progressive muscle relaxation',
        technique: 'Tense and release the major muscle groups for several minutes to lower acute anxiety.',
        sourceText: 'progressive muscle relaxation reduced state anxiety',
      }),
      usage: { totalTokens: 50 },
    });
    const body = paper.abstract;
    const r = await extract(paper, body);
    expect(r.candidate).not.toBeNull();
    expect(body).toContain(r.candidate!.sourceText);
    expect(r.candidate!.evidence).toBe('peer-reviewed: Randomized Controlled Trial');
    expect(r.candidate!.trustLevel).toBe('research-agent');
    expect(r.candidate!.sourceId).toBe('PMID:1');
  });

  it('returns null when the quoted sourceText is not actually in the body (hallucination guard)', async () => {
    generateText.mockResolvedValue({
      text: JSON.stringify({ title: 'X', technique: 'Y', sourceText: 'a quote that is not present' }),
      usage: { totalTokens: 10 },
    });
    expect((await extract(paper, paper.abstract)).candidate).toBeNull();
  });

  it('returns null when the model declines (no clean technique)', async () => {
    generateText.mockResolvedValue({ text: 'null', usage: { totalTokens: 8 } });
    expect((await extract(paper, paper.abstract)).candidate).toBeNull();
  });
});
