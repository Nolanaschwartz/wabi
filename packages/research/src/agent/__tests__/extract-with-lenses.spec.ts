// extractWithLenses extracts a paper's techniques in ONE call (slice 05): the body is sent once and the
// model tags each technique with a lens. It's a caller of the injected `gen` seam (a fake here) and owns
// the DOMAIN logic: single JSON-array parse, the verbatim-substring guard, lens validation, scope
// wording, and fail-open.
import { extractWithLenses } from '../extract-with-lenses';
import { SCOPE_FRAGMENT } from '../scope-policy';
import { Paper } from '../../types';
import type { ResearchGenerate } from '../research-generate';
import type { GenerateResult } from '@wabi/shared/generate';

const paper: Paper = {
  sourceId: 'PMID:1', sourceKind: 'pubmed', title: 'Coping techniques',
  abstract: 'box breathing lowered arousal; cognitive reappraisal reduced distress.',
  url: 'https://pubmed.ncbi.nlm.nih.gov/1', pubTypes: ['Randomized Controlled Trial'], isPreprint: false,
};

const reply = (text: string, totalTokens = 10): GenerateResult => ({ text, usage: { totalTokens }, model: 'm', latencyMs: 1 });
const genReturning = (r: GenerateResult): jest.MockedFunction<ResearchGenerate> =>
  jest.fn().mockResolvedValue(r) as jest.MockedFunction<ResearchGenerate>;

it('makes ONE call and tags each returned technique with its lens', async () => {
  const gen = genReturning(reply(JSON.stringify([
    { title: 'Box breathing', technique: 'inhale 4 hold 4', sourceText: 'box breathing lowered arousal', lens: 'behavioral' },
    { title: 'Reappraisal', technique: 'reframe the situation', sourceText: 'cognitive reappraisal reduced distress', lens: 'cognitive' },
  ])));

  const r = await extractWithLenses(gen, paper, paper.abstract, ['behavioral', 'cognitive']);

  expect(gen).toHaveBeenCalledTimes(1); // body sent once, not per lens
  expect(r.candidates).toHaveLength(2);
  expect(r.candidates.map((c) => c.lens)).toEqual(['behavioral', 'cognitive']);
  expect(r.candidates[0].evidenceTier).toBe('rct'); // tier carried from the paper, not the model
  expect(r.candidates.every((c) => paper.abstract.includes(c.sourceText))).toBe(true);
  expect(r.tokens).toBe(10);
});

it('calls gen with span "extract" and role "research"', async () => {
  const gen = genReturning(reply('[]'));
  await extractWithLenses(gen, paper, paper.abstract, ['behavioral']);
  expect(gen.mock.calls[0][0]).toBe('extract');
  expect(gen.mock.calls[0][1]).toBe('research');
});

it('still makes ONE call regardless of how many lenses are in scope', async () => {
  const gen = genReturning(reply('[]'));
  await extractWithLenses(gen, paper, paper.abstract, ['behavioral', 'cognitive', 'social', 'environmental', 'physiological']);
  expect(gen).toHaveBeenCalledTimes(1);
});

it('prompts with the shared scope fragment', async () => {
  const gen = genReturning(reply('[]'));
  await extractWithLenses(gen, paper, paper.abstract, ['behavioral']);
  expect(gen.mock.calls[0][2].prompt).toContain(SCOPE_FRAGMENT);
});

it('drops a candidate whose sourceText is not a verbatim substring (hallucination guard)', async () => {
  const gen = genReturning(reply(JSON.stringify([
    { title: 'Real', technique: 'r', sourceText: 'box breathing lowered arousal', lens: 'behavioral' },
    { title: 'Fake', technique: 'f', sourceText: 'a quote not present in the body', lens: 'behavioral' },
  ])));
  const r = await extractWithLenses(gen, paper, paper.abstract, ['behavioral']);
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0].title).toBe('Real');
});

it('tolerates lens casing from the model (normalizes "Behavioral" -> "behavioral")', async () => {
  const gen = genReturning(reply(JSON.stringify([
    { title: 'Box breathing', technique: 'inhale 4 hold 4', sourceText: 'box breathing lowered arousal', lens: 'Behavioral' },
  ])));
  const r = await extractWithLenses(gen, paper, paper.abstract, ['behavioral']);
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0].lens).toBe('behavioral');
});

it('drops a candidate tagged with a lens we did not ask for', async () => {
  const gen = genReturning(reply(JSON.stringify([
    { title: 'In', technique: 'i', sourceText: 'box breathing lowered arousal', lens: 'behavioral' },
    { title: 'Out', technique: 'o', sourceText: 'cognitive reappraisal reduced distress', lens: 'cognitive' },
  ])));
  const r = await extractWithLenses(gen, paper, paper.abstract, ['behavioral']); // cognitive not requested
  expect(r.candidates.map((c) => c.title)).toEqual(['In']);
});

it('is fail-open: a thrown call yields no candidates and never aborts the run', async () => {
  const gen = jest.fn().mockRejectedValue(new Error('provider down')) as jest.MockedFunction<ResearchGenerate>;
  const r = await extractWithLenses(gen, paper, paper.abstract, ['behavioral', 'cognitive']);
  expect(r.candidates).toHaveLength(0);
  expect(r.tokens).toBe(0);
});

it('treats an empty / null reply as no candidates', async () => {
  expect((await extractWithLenses(genReturning(reply('null')), paper, paper.abstract, ['behavioral'])).candidates).toHaveLength(0);
  expect((await extractWithLenses(genReturning(reply('[]')), paper, paper.abstract, ['behavioral'])).candidates).toHaveLength(0);
});
