// mergeWithinPaper collapses candidates from ONE paper that describe the same technique. The shared
// lexical prefilter resolves the clear cases (≥ ceiling auto-merges, < floor stays apart) with NO LLM;
// only the ambiguous band goes to a SINGLE clustering call through the injected `genObj` seam (a fake
// here). Schema decoding: when object is present, filterGroups applies the in-range constraint; when
// object is absent (soft failure) the lexical clusters are kept as-is (fail-open, ADR-0021).
import { mergeWithinPaper } from '../merge-within-paper';
import { Candidate, Lens } from '../../types';
import type { ResearchGenerateObject } from '../research-generate';

const genFn = (): jest.MockedFunction<ResearchGenerateObject> =>
  jest.fn() as jest.MockedFunction<ResearchGenerateObject>;

// Helper: genObj returns a {groups: [[...]]} object result
const groupResult = (groups: number[][], tokens: number) =>
  jest.fn().mockResolvedValue({ object: { groups }, tokens }) as jest.MockedFunction<ResearchGenerateObject>;

const mk = (title: string, technique: string, lens: Lens, sourceText = 's'): Candidate => ({
  title, technique, sourceText, evidence: 'peer-reviewed: RCT', evidenceTier: 'rct',
  sourceUrl: 'u', source: 'PubMed', sourceId: 'PMID:1', sourceKind: 'pubmed', trustLevel: 'research-agent', lens,
});

it('collapses the same technique surfaced by two lenses into one candidate', async () => {
  const genObj = genFn();
  const r = await mergeWithinPaper(genObj, [
    mk('Box breathing', 'inhale four hold four exhale four', 'behavioral'),
    mk('Box breathing', 'inhale four hold four exhale four', 'physiological'),
  ]);
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0].lenses).toEqual(['behavioral', 'physiological']);
  expect(r.candidates[0].lensAgreement).toBe(2);
  expect(genObj).not.toHaveBeenCalled(); // identical sig -> jaccard 1.0 -> no LLM
});

it('keeps genuinely distinct techniques separate', async () => {
  const genObj = genFn();
  const r = await mergeWithinPaper(genObj, [
    mk('Box breathing', 'inhale four hold four', 'behavioral'),
    mk('Cognitive reappraisal', 'reframe the stressful situation', 'cognitive'),
  ]);
  expect(r.candidates).toHaveLength(2);
  expect(r.candidates.map((c) => c.lensAgreement)).toEqual([1, 1]);
});

it('preserves the verbatim sourceText on the surviving candidate', async () => {
  const genObj = genFn();
  const r = await mergeWithinPaper(genObj, [
    mk('Box breathing', 'inhale four hold four', 'behavioral', 'box breathing lowered arousal'),
    mk('Box breathing', 'inhale four hold four', 'physiological', 'different quote'),
  ]);
  expect(r.candidates[0].sourceText).toBe('box breathing lowered arousal');
});

it('sends the ambiguous band to ONE clustering call (span "merge", role "research-triage") and merges per the returned groups', async () => {
  const genObj = groupResult([[0, 1]], 7);
  const r = await mergeWithinPaper(genObj, [
    mk('Box breathing', 'inhale and hold for several counts', 'behavioral'),
    mk('Square breathing drill', 'breathe in counts around a square', 'physiological'),
  ]);
  expect(genObj).toHaveBeenCalledTimes(1);
  expect(genObj.mock.calls[0][0]).toBe('merge');
  expect(genObj.mock.calls[0][1]).toBe('research-triage');
  expect(genObj.mock.calls[0][2].schema).toBeDefined();
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0].lensAgreement).toBe(2);
  expect(r.tokens).toBe(7);
});

it('ignores out-of-range indices in the clustering reply (no union-find corruption)', async () => {
  // The model returns index 5 which is past the involved list; it must be dropped by filterGroups, not
  // silently merged with an unrelated candidate resolved to undefined.
  const genObj = groupResult([[0, 5]], 3);
  const r = await mergeWithinPaper(genObj, [
    mk('Box breathing', 'inhale and hold for several counts', 'behavioral'),
    mk('Square breathing drill', 'breathe in counts around a square', 'physiological'),
  ]);
  expect(r.candidates).toHaveLength(2); // index 5 ignored -> no spurious merge
  expect(r.candidates.map((c) => c.lensAgreement)).toEqual([1, 1]);
});

it('is fail-open: a clustering error keeps every candidate (none dropped)', async () => {
  const genObj = jest.fn().mockRejectedValue(new Error('provider down')) as jest.MockedFunction<ResearchGenerateObject>;
  const r = await mergeWithinPaper(genObj, [
    mk('Box breathing', 'inhale and hold for several counts', 'behavioral'),
    mk('Square breathing drill', 'breathe in counts around a square', 'physiological'),
  ]);
  expect(r.candidates).toHaveLength(2);
  expect(r.tokens).toBe(0);
});

it('fail-open when genObj returns object undefined (schema soft failure): keeps lexical clusters', async () => {
  // An absent object means no extra merges — the ambiguous-band candidates stay in their lexical clusters.
  const genObj = jest.fn().mockResolvedValue({ object: undefined, tokens: 5 }) as jest.MockedFunction<ResearchGenerateObject>;
  const r = await mergeWithinPaper(genObj, [
    mk('Box breathing', 'inhale and hold for several counts', 'behavioral'),
    mk('Square breathing drill', 'breathe in counts around a square', 'physiological'),
  ]);
  expect(r.candidates).toHaveLength(2); // no extra merge applied — kept distinct
  expect(r.tokens).toBe(5); // tokens from the successful call are still counted
});

it('counts distinct lenses only (a lens repeated does not inflate agreement)', async () => {
  const genObj = genFn();
  const r = await mergeWithinPaper(genObj, [
    mk('Box breathing', 'inhale four hold four', 'behavioral'),
    mk('Box breathing', 'inhale four hold four', 'behavioral'),
  ]);
  expect(r.candidates[0].lenses).toEqual(['behavioral']);
  expect(r.candidates[0].lensAgreement).toBe(1);
});
