// extract is now a caller of @wabi/shared/generate: build prompt -> generate -> map result. The
// MECHANISM (provider resolution, ai client, the call) moved into generate; what stays here and is
// tested is extract's DOMAIN logic — JSON parse, the verbatim-substring hallucination guard, the
// evidence tag — and its fail policy (failure/empty -> null).
jest.mock('@wabi/shared/generate', () => ({ generate: jest.fn() }));

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
  const { generate } = require('@wabi/shared/generate') as { generate: jest.Mock };
  // generate returns { text, usage, model, latencyMs }; extract reads text + usage.totalTokens.
  const reply = (text: string, totalTokens?: number) => ({
    text,
    usage: totalTokens === undefined ? undefined : { totalTokens },
    model: 'm',
    latencyMs: 1,
  });
  beforeEach(() => jest.clearAllMocks());

  it('returns a candidate whose sourceText is a verbatim substring of the body', async () => {
    generate.mockResolvedValue(reply(JSON.stringify({
      title: 'Progressive muscle relaxation',
      technique: 'Tense and release the major muscle groups for several minutes to lower acute anxiety.',
      sourceText: 'progressive muscle relaxation reduced state anxiety',
    }), 50));
    const body = paper.abstract;
    const r = await extract(paper, body);
    expect(r.candidate).not.toBeNull();
    expect(body).toContain(r.candidate!.sourceText);
    expect(r.candidate!.evidence).toBe('peer-reviewed: Randomized Controlled Trial');
    expect(r.candidate!.trustLevel).toBe('research-agent');
    expect(r.candidate!.sourceId).toBe('PMID:1');
  });

  it('uses role "research" and opts out of retry-on-empty', async () => {
    generate.mockResolvedValue(reply('null', 8));
    await extract(paper, paper.abstract);
    expect(generate.mock.calls[0][0]).toBe('research');
    expect(generate.mock.calls[0][1].retryOnEmpty).toBeUndefined();
  });

  it('returns null when the quoted sourceText is not actually in the body (hallucination guard)', async () => {
    generate.mockResolvedValue(reply(JSON.stringify({ title: 'X', technique: 'Y', sourceText: 'a quote that is not present' }), 10));
    expect((await extract(paper, paper.abstract)).candidate).toBeNull();
  });

  it('returns null when the model declines (no clean technique)', async () => {
    generate.mockResolvedValue(reply('null', 8));
    expect((await extract(paper, paper.abstract)).candidate).toBeNull();
  });

  it('parses JSON the model wrapped in a ``` fenced code block', async () => {
    const json = JSON.stringify({
      title: 'Progressive muscle relaxation',
      technique: 'Tense and release the major muscle groups for several minutes to lower acute anxiety.',
      sourceText: 'progressive muscle relaxation reduced state anxiety',
    });
    generate.mockResolvedValue(reply('```json\n' + json + '\n```', 70));
    const r = await extract(paper, paper.abstract);
    expect(r.candidate).not.toBeNull();
    expect(r.candidate!.title).toBe('Progressive muscle relaxation');
  });

  it('returns null on EMPTY output — a reasoning model starved by the cap returns ""', async () => {
    generate.mockResolvedValue(reply('', 400));
    expect((await extract(paper, paper.abstract)).candidate).toBeNull();
  });

  it('returns null when generate throws (transport failure) — extract owns the fail policy', async () => {
    generate.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await extract(paper, paper.abstract);
    expect(r.candidate).toBeNull();
    expect(r.tokens).toBe(0);
  });

  it('requests an output budget large enough to fit reasoning + the full JSON object', async () => {
    generate.mockResolvedValue(reply('null', 8));
    await extract(paper, paper.abstract);
    expect(generate.mock.calls[0][1].maxOutputTokens).toBeGreaterThanOrEqual(2000);
  });
});
