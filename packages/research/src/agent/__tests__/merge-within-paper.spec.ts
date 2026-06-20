// mergeWithinPaper collapses candidates from ONE paper that describe the same technique. The shared
// lexical prefilter resolves the clear cases (≥ ceiling auto-merges, < floor stays apart) with NO LLM;
// only the ambiguous band goes to a SINGLE clustering call through the injected `gen` seam (a fake here).
import { mergeWithinPaper } from '../merge-within-paper';
import { Candidate, Lens } from '../../types';
import type { ResearchGenerate } from '../research-generate';
import type { GenerateResult } from '@wabi/shared/generate';

const genFn = (): jest.MockedFunction<ResearchGenerate> => jest.fn() as jest.MockedFunction<ResearchGenerate>;
const result = (text: string, totalTokens: number): GenerateResult => ({ text, usage: { totalTokens }, model: 'm', latencyMs: 1 });

const mk = (title: string, technique: string, lens: Lens, sourceText = 's'): Candidate => ({
  title, technique, sourceText, evidence: 'peer-reviewed: RCT', evidenceTier: 'rct',
  sourceUrl: 'u', source: 'PubMed', sourceId: 'PMID:1', sourceKind: 'pubmed', trustLevel: 'research-agent', lens,
});

it('collapses the same technique surfaced by two lenses into one candidate', async () => {
  const gen = genFn();
  const r = await mergeWithinPaper(gen, [
    mk('Box breathing', 'inhale four hold four exhale four', 'behavioral'),
    mk('Box breathing', 'inhale four hold four exhale four', 'physiological'),
  ]);
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0].lenses).toEqual(['behavioral', 'physiological']);
  expect(r.candidates[0].lensAgreement).toBe(2);
  expect(gen).not.toHaveBeenCalled(); // identical sig -> jaccard 1.0 -> no LLM
});

it('keeps genuinely distinct techniques separate', async () => {
  const gen = genFn();
  const r = await mergeWithinPaper(gen, [
    mk('Box breathing', 'inhale four hold four', 'behavioral'),
    mk('Cognitive reappraisal', 'reframe the stressful situation', 'cognitive'),
  ]);
  expect(r.candidates).toHaveLength(2);
  expect(r.candidates.map((c) => c.lensAgreement)).toEqual([1, 1]);
});

it('preserves the verbatim sourceText on the surviving candidate', async () => {
  const gen = genFn();
  const r = await mergeWithinPaper(gen, [
    mk('Box breathing', 'inhale four hold four', 'behavioral', 'box breathing lowered arousal'),
    mk('Box breathing', 'inhale four hold four', 'physiological', 'different quote'),
  ]);
  expect(r.candidates[0].sourceText).toBe('box breathing lowered arousal');
});

it('sends the ambiguous band to ONE clustering call (span "merge", role "research-triage") and merges per the returned groups', async () => {
  const gen = genFn();
  gen.mockResolvedValue(result('[[0,1]]', 7));
  const r = await mergeWithinPaper(gen, [
    mk('Box breathing', 'inhale and hold for several counts', 'behavioral'),
    mk('Square breathing drill', 'breathe in counts around a square', 'physiological'),
  ]);
  expect(gen).toHaveBeenCalledTimes(1);
  expect(gen.mock.calls[0][0]).toBe('merge');
  expect(gen.mock.calls[0][1]).toBe('research-triage');
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0].lensAgreement).toBe(2);
  expect(r.tokens).toBe(7);
});

it('ignores out-of-range indices in the clustering reply (no union-find corruption)', async () => {
  const gen = genFn();
  // The model returns an index (5) past the involved list; it must be dropped, not silently merge
  // unrelated candidates by resolving to undefined.
  gen.mockResolvedValue(result('[[0, 5]]', 3));
  const r = await mergeWithinPaper(gen, [
    mk('Box breathing', 'inhale and hold for several counts', 'behavioral'),
    mk('Square breathing drill', 'breathe in counts around a square', 'physiological'),
  ]);
  expect(r.candidates).toHaveLength(2); // index 5 ignored -> no spurious merge
  expect(r.candidates.map((c) => c.lensAgreement)).toEqual([1, 1]);
});

it('is fail-open: a clustering error keeps every candidate (none dropped)', async () => {
  const gen = genFn();
  gen.mockRejectedValue(new Error('provider down'));
  const r = await mergeWithinPaper(gen, [
    mk('Box breathing', 'inhale and hold for several counts', 'behavioral'),
    mk('Square breathing drill', 'breathe in counts around a square', 'physiological'),
  ]);
  expect(r.candidates).toHaveLength(2);
  expect(r.tokens).toBe(0);
});

it('counts distinct lenses only (a lens repeated does not inflate agreement)', async () => {
  const gen = genFn();
  const r = await mergeWithinPaper(gen, [
    mk('Box breathing', 'inhale four hold four', 'behavioral'),
    mk('Box breathing', 'inhale four hold four', 'behavioral'),
  ]);
  expect(r.candidates[0].lenses).toEqual(['behavioral']);
  expect(r.candidates[0].lensAgreement).toBe(1);
});
