// extractWithLenses now extracts a paper's techniques in ONE call (slice 05): the body is sent once
// and the model tags each technique with a lens. It's a caller of @wabi/shared/generate (mocked here)
// and owns the DOMAIN logic: single JSON-array parse, the verbatim-substring guard, lens validation,
// scope wording, and fail-open.
jest.mock('@wabi/shared/generate', () => ({ generate: jest.fn() }));

import { extractWithLenses } from '../extract-with-lenses';
import { SCOPE_FRAGMENT } from '../scope-policy';
import { Paper } from '../../types';

const paper: Paper = {
  sourceId: 'PMID:1', sourceKind: 'pubmed', title: 'Coping techniques',
  abstract: 'box breathing lowered arousal; cognitive reappraisal reduced distress.',
  url: 'https://pubmed.ncbi.nlm.nih.gov/1', pubTypes: ['Randomized Controlled Trial'], isPreprint: false,
};

const { generate } = require('@wabi/shared/generate') as { generate: jest.Mock };
const reply = (text: string, totalTokens = 10) => ({ text, usage: { totalTokens }, model: 'm', latencyMs: 1 });

beforeEach(() => jest.clearAllMocks());

it('makes ONE call and tags each returned technique with its lens', async () => {
  generate.mockResolvedValueOnce(reply(JSON.stringify([
    { title: 'Box breathing', technique: 'inhale 4 hold 4', sourceText: 'box breathing lowered arousal', lens: 'behavioral' },
    { title: 'Reappraisal', technique: 'reframe the situation', sourceText: 'cognitive reappraisal reduced distress', lens: 'cognitive' },
  ])));

  const r = await extractWithLenses(paper, paper.abstract, ['behavioral', 'cognitive']);

  expect(generate).toHaveBeenCalledTimes(1); // body sent once, not per lens
  expect(r.candidates).toHaveLength(2);
  expect(r.candidates.map((c) => c.lens)).toEqual(['behavioral', 'cognitive']);
  expect(r.candidates[0].evidenceTier).toBe('rct'); // tier carried from the paper, not the model
  expect(r.candidates.every((c) => paper.abstract.includes(c.sourceText))).toBe(true);
  expect(r.tokens).toBe(10);
});

it('still makes ONE call regardless of how many lenses are in scope', async () => {
  generate.mockResolvedValueOnce(reply('[]'));
  await extractWithLenses(paper, paper.abstract, ['behavioral', 'cognitive', 'social', 'environmental', 'physiological']);
  expect(generate).toHaveBeenCalledTimes(1);
});

it('prompts with the shared scope fragment', async () => {
  generate.mockResolvedValueOnce(reply('[]'));
  await extractWithLenses(paper, paper.abstract, ['behavioral']);
  expect(generate.mock.calls[0][1].prompt).toContain(SCOPE_FRAGMENT);
});

it('drops a candidate whose sourceText is not a verbatim substring (hallucination guard)', async () => {
  generate.mockResolvedValueOnce(reply(JSON.stringify([
    { title: 'Real', technique: 'r', sourceText: 'box breathing lowered arousal', lens: 'behavioral' },
    { title: 'Fake', technique: 'f', sourceText: 'a quote not present in the body', lens: 'behavioral' },
  ])));
  const r = await extractWithLenses(paper, paper.abstract, ['behavioral']);
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0].title).toBe('Real');
});

it('tolerates lens casing from the model (normalizes "Behavioral" -> "behavioral")', async () => {
  generate.mockResolvedValueOnce(reply(JSON.stringify([
    { title: 'Box breathing', technique: 'inhale 4 hold 4', sourceText: 'box breathing lowered arousal', lens: 'Behavioral' },
  ])));
  const r = await extractWithLenses(paper, paper.abstract, ['behavioral']);
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0].lens).toBe('behavioral');
});

it('drops a candidate tagged with a lens we did not ask for', async () => {
  generate.mockResolvedValueOnce(reply(JSON.stringify([
    { title: 'In', technique: 'i', sourceText: 'box breathing lowered arousal', lens: 'behavioral' },
    { title: 'Out', technique: 'o', sourceText: 'cognitive reappraisal reduced distress', lens: 'cognitive' },
  ])));
  const r = await extractWithLenses(paper, paper.abstract, ['behavioral']); // cognitive not requested
  expect(r.candidates.map((c) => c.title)).toEqual(['In']);
});

it('is fail-open: a thrown call yields no candidates and never aborts the run', async () => {
  generate.mockRejectedValueOnce(new Error('provider down'));
  const r = await extractWithLenses(paper, paper.abstract, ['behavioral', 'cognitive']);
  expect(r.candidates).toHaveLength(0);
  expect(r.tokens).toBe(0);
});

it('treats an empty / null reply as no candidates', async () => {
  generate.mockResolvedValueOnce(reply('null'));
  expect((await extractWithLenses(paper, paper.abstract, ['behavioral'])).candidates).toHaveLength(0);
  generate.mockResolvedValueOnce(reply('[]'));
  expect((await extractWithLenses(paper, paper.abstract, ['behavioral'])).candidates).toHaveLength(0);
});
