// judgeCandidates scores each candidate (faithfulness + quality), drops below the tier floor, may
// sharpen title/technique (never sourceText), and caps top-N by score per tier. It calls the injected
// `genObj` seam (schema-decoded; a fake here) — the scope / fail-open policy stay in the step.
// Schema decoding: when object present use verdicts directly; when absent every index falls open to 0.5.
import { judgeCandidates } from '../judge';
import { Candidate, EvidenceTier } from '../../types';
import type { ResearchGenerateObject } from '../research-generate';

// Helper: wraps a single verdict in the {verdicts:[v]} envelope that matches JudgeSchema.
const verdict = (v: object, tokens = 5): jest.MockedFunction<ResearchGenerateObject> =>
  jest.fn().mockResolvedValue({ object: { verdicts: [v] }, tokens }) as jest.MockedFunction<ResearchGenerateObject>;

// Helper: wraps multiple verdicts in the batched envelope.
const batchVerdict = (vs: object[], tokens = 5): jest.MockedFunction<ResearchGenerateObject> =>
  jest.fn().mockResolvedValue({ object: { verdicts: vs }, tokens }) as jest.MockedFunction<ResearchGenerateObject>;

// A fake `genObj` with no default return — each test scripts its own return/reject.
const genFn = (): jest.MockedFunction<ResearchGenerateObject> => jest.fn() as jest.MockedFunction<ResearchGenerateObject>;

const mk = (title: string, tier: EvidenceTier = 'rct'): Candidate => ({
  title, technique: `do ${title}`, sourceText: `quote ${title}`, evidence: 'e', evidenceTier: tier,
  sourceUrl: 'u', source: 'PubMed', sourceId: 'PMID:1', sourceKind: 'pubmed', trustLevel: 'research-agent',
});

// Shared fixtures for batch tests.
const candA = mk('A');
const candB = mk('B');

it('keeps a faithful candidate and sets confidence + rationale', async () => {
  const genObj = verdict({ faithful: true, score: 0.9, rationale: 'clear and grounded' });
  const r = await judgeCandidates(genObj, [mk('A')], 'rct');
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0].confidence).toBe(0.9);
  expect(r.candidates[0].rationale).toBe('clear and grounded');
});

it('drops a candidate the judge marks unfaithful', async () => {
  const genObj = verdict({ faithful: false, score: 0.95, rationale: 'sourceText does not support it' });
  const r = await judgeCandidates(genObj, [mk('A')], 'rct');
  expect(r.candidates).toHaveLength(0);
});

it('drops a faithful-but-out-of-scope candidate even with a high quality score', async () => {
  const genObj = verdict({ faithful: true, scopeOk: false, score: 0.95, rationale: 'requires a supplement' });
  const r = await judgeCandidates(genObj, [mk('Take Vitamin D')], 'rct');
  expect(r.candidates).toHaveLength(0);
});

it('keeps a faithful, in-scope candidate above the floor', async () => {
  const genObj = verdict({ faithful: true, scopeOk: true, score: 0.8, rationale: 'self-administered' });
  const r = await judgeCandidates(genObj, [mk('A')], 'rct');
  expect(r.candidates).toHaveLength(1);
});

it('prompts with the shared scope fragment, via span "judge" + role "research", and passes a schema', async () => {
  const genObj = verdict({ faithful: true, scopeOk: true, score: 0.8, rationale: 'r' });
  await judgeCandidates(genObj, [mk('A')], 'rct');
  expect(genObj.mock.calls[0][0]).toBe('judge');
  expect(genObj.mock.calls[0][1]).toBe('research');
  expect(genObj.mock.calls[0][2].prompt).toContain(require('../scope-policy').SCOPE_FRAGMENT);
  expect(genObj.mock.calls[0][2].schema).toBeDefined();
});

it('tells the model to emit JSON only, so a chatty reasoning model does not break the parse', async () => {
  const genObj = verdict({ faithful: true, scopeOk: true, score: 0.8, rationale: 'r' });
  await judgeCandidates(genObj, [mk('A')], 'rct');
  expect(genObj.mock.calls[0][2].prompt).toMatch(/only the JSON|no other text|no prose/i);
});

it('holds preprints to a stricter floor than peer-reviewed work', async () => {
  // 0.6 clears the peer-reviewed floor (0.5) but not the stricter preprint floor (0.7).
  expect((await judgeCandidates(verdict({ faithful: true, score: 0.6, rationale: 'ok' }), [mk('A', 'rct')], 'rct')).candidates).toHaveLength(1);
  expect((await judgeCandidates(verdict({ faithful: true, score: 0.6, rationale: 'ok' }), [mk('A', 'preprint')], 'preprint')).candidates).toHaveLength(0);
});

it('applies the judge rewrite to title/technique but never to sourceText', async () => {
  const genObj = verdict({ faithful: true, score: 0.8, title: 'Sharper title', technique: 'sharper technique', rationale: 'r' });
  const r = await judgeCandidates(genObj, [mk('A')], 'rct');
  expect(r.candidates[0].title).toBe('Sharper title');
  expect(r.candidates[0].technique).toBe('sharper technique');
  expect(r.candidates[0].sourceText).toBe('quote A'); // immutable — sourceText is never rewritten
});

it('caps peer-reviewed papers to the top 5 by score', async () => {
  const genObj = batchVerdict(
    [0.9, 0.85, 0.8, 0.75, 0.7, 0.65].map((s) => ({ faithful: true, score: s, rationale: 'r' })),
    30,
  );
  const r = await judgeCandidates(genObj, [mk('A'), mk('B'), mk('C'), mk('D'), mk('E'), mk('F')], 'rct');
  expect(r.candidates).toHaveLength(5);
  expect(r.candidates.map((c) => c.confidence)).toEqual([0.9, 0.85, 0.8, 0.75, 0.7]);
});

it('caps preprints to the top 2 by score', async () => {
  // All three scores clear the preprint floor (0.7); one call returns all verdicts, cap trims to 2.
  const genObj = batchVerdict(
    [0.95, 0.9, 0.85].map((s) => ({ faithful: true, score: s, rationale: 'r' })),
    15,
  );
  const r = await judgeCandidates(genObj, [mk('A', 'preprint'), mk('B', 'preprint'), mk('C', 'preprint')], 'preprint');
  expect(r.candidates).toHaveLength(2);
});

it('is fail-open: a judge error keeps the candidate at a neutral score (never silently dropped)', async () => {
  const genObj = genFn();
  genObj.mockRejectedValue(new Error('provider down'));
  const r = await judgeCandidates(genObj, [mk('A')], 'rct');
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0].confidence).toBe(0.5);
});

it('per-index fail-open when genObj returns object undefined: all candidates at 0.5, tokens counted', async () => {
  // Schema/soft failure: genObj succeeded (tokens spent) but object is absent.
  // Every index falls open to the per-index neutral — tokens are still counted from the successful call.
  const genObj = jest.fn().mockResolvedValue({ object: undefined, tokens: 42 }) as jest.MockedFunction<ResearchGenerateObject>;
  const r = await judgeCandidates(genObj, [mk('A')], 'rct');
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0].confidence).toBe(0.5);
  expect(r.tokens).toBe(42);
});

// ── Batch-specific tests ──────────────────────────────────────────────────────────────────────────

it('judges all candidates in a single genObj call', async () => {
  const genObj = batchVerdict([
    { faithful: true, scopeOk: true, score: 0.9, title: 'A', technique: 'a', rationale: 'r' },
    { faithful: true, scopeOk: true, score: 0.8, title: 'B', technique: 'b', rationale: 'r' },
  ], 50);
  const out = await judgeCandidates(genObj, [candA, candB], 'rct');
  expect(genObj).toHaveBeenCalledTimes(1);
  expect(out.candidates).toHaveLength(2);
  expect(out.tokens).toBe(50);
});

it('falls open per-index: a missing verdict keeps that candidate at 0.5, others judged normally', async () => {
  const genObj = batchVerdict([
    { faithful: true, scopeOk: true, score: 0.9, title: 'A', technique: 'a', rationale: 'r' },
    // only one verdict for two candidates — candB gets no entry
  ], 30);
  const out = await judgeCandidates(genObj, [candA, candB], 'rct');
  const b = out.candidates.find((c) => c.sourceText === candB.sourceText);
  expect(b?.confidence).toBe(0.5);
  expect(b?.rationale).toBe('judge unavailable');
});

it('counts tokens from genObj even when object is undefined (soft failure)', async () => {
  // genObj succeeded (real spend) but returned no object. The fail-open path must still keep the
  // candidate AND report the spend — dropping it to 0 under-counts the run budget and defeats the
  // tokenBudget stop / single-lens budget-pressure collapse downstream.
  const genObj = jest.fn().mockResolvedValue({ object: undefined, tokens: 40 }) as jest.MockedFunction<ResearchGenerateObject>;
  const out = await judgeCandidates(genObj, [candA], 'rct');
  expect(out.tokens).toBe(40);
  expect(out.candidates[0].confidence).toBe(0.5);
});
