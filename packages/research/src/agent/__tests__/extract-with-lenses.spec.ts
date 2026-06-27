// extractWithLenses extracts a paper's techniques in ONE call (slice 05): the body is sent once and the
// model tags each technique with a lens. It's a caller of the injected `genObj` seam (schema-decoded;
// a fake here) and owns the DOMAIN logic: verbatim-substring guard, lens validation, scope wording,
// audience-neutral wording, and fail-open. Schema decoding means no stripFences/JSON.parse — when
// object is present the techniques array is used directly; when absent fail-open yields no candidates.
import { extractWithLenses } from '../extract-with-lenses';
import { SCOPE_FRAGMENT } from '../scope-policy';
import { Paper } from '../../types';
import type { ResearchGenerateObject } from '../research-generate';

const paper: Paper = {
  sourceId: 'PMID:1', sourceKind: 'pubmed', title: 'Coping techniques',
  abstract: 'box breathing lowered arousal; cognitive reappraisal reduced distress.',
  url: 'https://pubmed.ncbi.nlm.nih.gov/1', pubTypes: ['Randomized Controlled Trial'], isPreprint: false,
};

// A fake `genObj`: returns {object, tokens}. Mimics the ResearchGenerateObject contract.
const genObjReturning = <T>(object: T | undefined, tokens = 10): jest.MockedFunction<ResearchGenerateObject> =>
  jest.fn().mockResolvedValue({ object, tokens }) as jest.MockedFunction<ResearchGenerateObject>;

it('makes ONE call and tags each returned technique with its lens (object present path)', async () => {
  const genObj = genObjReturning({
    techniques: [
      { title: 'Box breathing', technique: 'inhale 4 hold 4', sourceText: 'box breathing lowered arousal', lens: 'behavioral' },
      { title: 'Reappraisal', technique: 'reframe the situation', sourceText: 'cognitive reappraisal reduced distress', lens: 'cognitive' },
    ],
  });

  const r = await extractWithLenses(genObj, paper, paper.abstract, ['behavioral', 'cognitive']);

  expect(genObj).toHaveBeenCalledTimes(1); // body sent once, not per lens
  expect(r.candidates).toHaveLength(2);
  expect(r.candidates.map((c) => c.lens)).toEqual(['behavioral', 'cognitive']);
  expect(r.candidates[0].evidenceTier).toBe('rct'); // tier carried from the paper, not the model
  expect(r.candidates.every((c) => paper.abstract.includes(c.sourceText))).toBe(true);
  expect(r.tokens).toBe(10);
});

it('calls genObj with span "extract", role "research", and a schema', async () => {
  const genObj = genObjReturning({ techniques: [] });
  await extractWithLenses(genObj, paper, paper.abstract, ['behavioral']);
  expect(genObj.mock.calls[0][0]).toBe('extract');
  expect(genObj.mock.calls[0][1]).toBe('research');
  expect(genObj.mock.calls[0][2].schema).toBeDefined();
});

it('still makes ONE call regardless of how many lenses are in scope', async () => {
  const genObj = genObjReturning({ techniques: [] });
  await extractWithLenses(genObj, paper, paper.abstract, ['behavioral', 'cognitive', 'social', 'environmental', 'physiological']);
  expect(genObj).toHaveBeenCalledTimes(1);
});

it('prompts with the shared scope fragment', async () => {
  const genObj = genObjReturning({ techniques: [] });
  await extractWithLenses(genObj, paper, paper.abstract, ['behavioral']);
  expect(genObj.mock.calls[0][2].prompt).toContain(SCOPE_FRAGMENT);
});

it('tells the model to emit JSON only, so a chatty reasoning model does not break the parse', async () => {
  const genObj = genObjReturning({ techniques: [] });
  await extractWithLenses(genObj, paper, paper.abstract, ['behavioral']);
  expect(genObj.mock.calls[0][2].prompt).toMatch(/only the JSON|no other text|no prose/i);
});

it('drops a candidate whose sourceText is not a verbatim substring (hallucination guard)', async () => {
  const genObj = genObjReturning({
    techniques: [
      { title: 'Real', technique: 'r', sourceText: 'box breathing lowered arousal', lens: 'behavioral' },
      { title: 'Fake', technique: 'f', sourceText: 'a quote not present in the body', lens: 'behavioral' },
    ],
  });
  const r = await extractWithLenses(genObj, paper, paper.abstract, ['behavioral']);
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0].title).toBe('Real');
});

it('tolerates lens casing from the model (normalizes "Behavioral" -> "behavioral")', async () => {
  const genObj = genObjReturning({
    techniques: [
      { title: 'Box breathing', technique: 'inhale 4 hold 4', sourceText: 'box breathing lowered arousal', lens: 'Behavioral' },
    ],
  });
  const r = await extractWithLenses(genObj, paper, paper.abstract, ['behavioral']);
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0].lens).toBe('behavioral');
});

it('drops a candidate tagged with a lens we did not ask for', async () => {
  const genObj = genObjReturning({
    techniques: [
      { title: 'In', technique: 'i', sourceText: 'box breathing lowered arousal', lens: 'behavioral' },
      { title: 'Out', technique: 'o', sourceText: 'cognitive reappraisal reduced distress', lens: 'cognitive' },
    ],
  });
  const r = await extractWithLenses(genObj, paper, paper.abstract, ['behavioral']); // cognitive not requested
  expect(r.candidates.map((c) => c.title)).toEqual(['In']);
});

it('is fail-open: a thrown call yields no candidates and never aborts the run', async () => {
  const genObj = jest.fn().mockRejectedValue(new Error('provider down')) as jest.MockedFunction<ResearchGenerateObject>;
  const r = await extractWithLenses(genObj, paper, paper.abstract, ['behavioral', 'cognitive']);
  expect(r.candidates).toHaveLength(0);
  expect(r.tokens).toBe(0);
});

it('returns no candidates when genObj returns object undefined (schema/soft failure — fail-open)', async () => {
  // An absent object must not crash and must yield no candidates, not a rejection of the run.
  const genObj = genObjReturning(undefined, 7);
  const r = await extractWithLenses(genObj, paper, paper.abstract, ['behavioral']);
  expect(r.candidates).toHaveLength(0);
  expect(r.tokens).toBe(7); // tokens from the successful call are still counted
});

it('returns no candidates when the techniques array is empty', async () => {
  const genObj = genObjReturning({ techniques: [] });
  const r = await extractWithLenses(genObj, paper, paper.abstract, ['behavioral']);
  expect(r.candidates).toHaveLength(0);
  expect(r.tokens).toBe(10);
});
