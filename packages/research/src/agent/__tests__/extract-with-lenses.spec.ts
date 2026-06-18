// extractWithLenses fans one paper out across several lenses in parallel, each emitting 0..K
// candidates. Like extract, it's a caller of @wabi/shared/generate (mocked here) and owns the DOMAIN
// logic: per-lens JSON-array parse, the verbatim-substring guard, lens tagging, and fail-open.
jest.mock('@wabi/shared/generate', () => ({ generate: jest.fn() }));

import { extractWithLenses } from '../extract-with-lenses';
import { Paper } from '../../types';

const paper: Paper = {
  sourceId: 'PMID:1', sourceKind: 'pubmed', title: 'Coping techniques',
  abstract: 'box breathing lowered arousal; cognitive reappraisal reduced distress.',
  url: 'https://pubmed.ncbi.nlm.nih.gov/1', pubTypes: ['Randomized Controlled Trial'], isPreprint: false,
};

const { generate } = require('@wabi/shared/generate') as { generate: jest.Mock };
const reply = (text: string, totalTokens = 10) => ({ text, usage: { totalTokens }, model: 'm', latencyMs: 1 });

beforeEach(() => jest.clearAllMocks());

it('runs each lens and tags every candidate with its originating lens', async () => {
  generate
    .mockResolvedValueOnce(reply(JSON.stringify([{ title: 'Box breathing', technique: 'inhale 4 hold 4', sourceText: 'box breathing lowered arousal' }])))
    .mockResolvedValueOnce(reply(JSON.stringify([{ title: 'Reappraisal', technique: 'reframe the situation', sourceText: 'cognitive reappraisal reduced distress' }])));

  const r = await extractWithLenses(paper, paper.abstract, ['behavioral', 'cognitive']);

  expect(r.candidates).toHaveLength(2);
  expect(r.candidates.map((c) => c.lens)).toEqual(['behavioral', 'cognitive']);
  expect(r.candidates[0].evidenceTier).toBe('rct'); // tier carried from the paper
  expect(r.candidates.every((c) => paper.abstract.includes(c.sourceText))).toBe(true);
  expect(r.tokens).toBe(20);
});

it('keeps every technique a single lens surfaces (0..K per lens)', async () => {
  generate.mockResolvedValueOnce(reply(JSON.stringify([
    { title: 'A', technique: 'a', sourceText: 'box breathing lowered arousal' },
    { title: 'B', technique: 'b', sourceText: 'cognitive reappraisal reduced distress' },
  ])));
  const r = await extractWithLenses(paper, paper.abstract, ['behavioral']);
  expect(r.candidates).toHaveLength(2);
});

it('drops a candidate whose sourceText is not a verbatim substring (hallucination guard)', async () => {
  generate.mockResolvedValueOnce(reply(JSON.stringify([
    { title: 'Real', technique: 'r', sourceText: 'box breathing lowered arousal' },
    { title: 'Fake', technique: 'f', sourceText: 'a quote not present in the body' },
  ])));
  const r = await extractWithLenses(paper, paper.abstract, ['behavioral']);
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0].title).toBe('Real');
});

it('is fail-open: a lens that throws contributes nothing and never aborts the others', async () => {
  generate
    .mockRejectedValueOnce(new Error('provider down'))
    .mockResolvedValueOnce(reply(JSON.stringify([{ title: 'Reappraisal', technique: 'reframe', sourceText: 'cognitive reappraisal reduced distress' }])));
  const r = await extractWithLenses(paper, paper.abstract, ['behavioral', 'cognitive']);
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0].lens).toBe('cognitive');
});

it('treats an empty / null lens reply as no candidates', async () => {
  generate
    .mockResolvedValueOnce(reply('null'))
    .mockResolvedValueOnce(reply('[]'));
  const r = await extractWithLenses(paper, paper.abstract, ['behavioral', 'cognitive']);
  expect(r.candidates).toHaveLength(0);
});
