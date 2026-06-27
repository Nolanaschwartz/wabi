// judgeCandidates scores each candidate (faithfulness + quality), drops below the tier floor, may
// sharpen title/technique (never sourceText), and caps top-N by score per tier. It calls the injected
// `gen` seam (a fake here) — the verbatim guard / scope / fail-open policy stay in the step.
import { judgeCandidates } from '../judge';
import { Candidate, EvidenceTier } from '../../types';
import type { ResearchGenerate } from '../research-generate';
import type { GenerateResult } from '@wabi/shared/generate';

// Single-item helper: wraps verdict in the batched { verdicts: [v] } envelope the judge now returns.
const verdict = (v: object, totalTokens = 5): GenerateResult => ({ text: JSON.stringify({ verdicts: [v] }), usage: { totalTokens }, model: 'm', latencyMs: 1 });
// Multi-item helper: wraps an array of verdicts in the batched envelope.
const batchVerdict = (vs: object[], totalTokens = 5): GenerateResult => ({ text: JSON.stringify({ verdicts: vs }), usage: { totalTokens }, model: 'm', latencyMs: 1 });

// A fake `gen` that resolves the next queued reply (so per-call scripting via mockResolvedValueOnce works).
const genFn = (): jest.MockedFunction<ResearchGenerate> => jest.fn() as jest.MockedFunction<ResearchGenerate>;

const mk = (title: string, tier: EvidenceTier = 'rct'): Candidate => ({
  title, technique: `do ${title}`, sourceText: `quote ${title}`, evidence: 'e', evidenceTier: tier,
  sourceUrl: 'u', source: 'PubMed', sourceId: 'PMID:1', sourceKind: 'pubmed', trustLevel: 'research-agent',
});

// Shared fixtures for batch tests (illustrative names from the brief map to mk('A') / mk('B')).
const candA = mk('A');
const candB = mk('B');

it('keeps a faithful candidate and sets confidence + rationale', async () => {
  const gen = genFn();
  gen.mockResolvedValue(verdict({ faithful: true, score: 0.9, rationale: 'clear and grounded' }));
  const r = await judgeCandidates(gen, [mk('A')], 'rct');
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0].confidence).toBe(0.9);
  expect(r.candidates[0].rationale).toBe('clear and grounded');
});

it('drops a candidate the judge marks unfaithful', async () => {
  const gen = genFn();
  gen.mockResolvedValue(verdict({ faithful: false, score: 0.95, rationale: 'sourceText does not support it' }));
  const r = await judgeCandidates(gen, [mk('A')], 'rct');
  expect(r.candidates).toHaveLength(0);
});

it('drops a faithful-but-out-of-scope candidate even with a high quality score', async () => {
  const gen = genFn();
  gen.mockResolvedValue(verdict({ faithful: true, scopeOk: false, score: 0.95, rationale: 'requires a supplement' }));
  const r = await judgeCandidates(gen, [mk('Take Vitamin D')], 'rct');
  expect(r.candidates).toHaveLength(0);
});

it('keeps a faithful, in-scope candidate above the floor', async () => {
  const gen = genFn();
  gen.mockResolvedValue(verdict({ faithful: true, scopeOk: true, score: 0.8, rationale: 'self-administered' }));
  const r = await judgeCandidates(gen, [mk('A')], 'rct');
  expect(r.candidates).toHaveLength(1);
});

it('prompts with the shared scope fragment, via span "judge" + role "research"', async () => {
  const gen = genFn();
  gen.mockResolvedValue(verdict({ faithful: true, scopeOk: true, score: 0.8, rationale: 'r' }));
  await judgeCandidates(gen, [mk('A')], 'rct');
  expect(gen.mock.calls[0][0]).toBe('judge');
  expect(gen.mock.calls[0][1]).toBe('research');
  expect(gen.mock.calls[0][2].prompt).toContain(require('../scope-policy').SCOPE_FRAGMENT);
});

it('tells the model to emit JSON only, so a chatty reasoning model does not break the parse', async () => {
  const gen = genFn();
  gen.mockResolvedValue(verdict({ faithful: true, scopeOk: true, score: 0.8, rationale: 'r' }));
  await judgeCandidates(gen, [mk('A')], 'rct');
  expect(gen.mock.calls[0][2].prompt).toMatch(/only the JSON|no other text|no prose/i);
});

it('holds preprints to a stricter floor than peer-reviewed work', async () => {
  const gen = genFn();
  gen.mockResolvedValue(verdict({ faithful: true, score: 0.6, rationale: 'ok' }));
  // 0.6 clears the peer-reviewed floor but not the stricter preprint floor.
  expect((await judgeCandidates(gen, [mk('A', 'rct')], 'rct')).candidates).toHaveLength(1);
  expect((await judgeCandidates(gen, [mk('A', 'preprint')], 'preprint')).candidates).toHaveLength(0);
});

it('applies the judge rewrite to title/technique but never to sourceText', async () => {
  const gen = genFn();
  gen.mockResolvedValue(verdict({ faithful: true, score: 0.8, title: 'Sharper title', technique: 'sharper technique', rationale: 'r' }));
  const r = await judgeCandidates(gen, [mk('A')], 'rct');
  expect(r.candidates[0].title).toBe('Sharper title');
  expect(r.candidates[0].technique).toBe('sharper technique');
  expect(r.candidates[0].sourceText).toBe('quote A'); // immutable
});

it('caps peer-reviewed papers to the top 5 by score', async () => {
  const gen = genFn();
  // 6 candidates, all in one batched call; the lowest score is dropped by the cap.
  gen.mockResolvedValue(batchVerdict(
    [0.9, 0.85, 0.8, 0.75, 0.7, 0.65].map((s) => ({ faithful: true, score: s, rationale: 'r' })),
    30,
  ));
  const r = await judgeCandidates(gen, [mk('A'), mk('B'), mk('C'), mk('D'), mk('E'), mk('F')], 'rct');
  expect(r.candidates).toHaveLength(5);
  expect(r.candidates.map((c) => c.confidence)).toEqual([0.9, 0.85, 0.8, 0.75, 0.7]);
});

it('caps preprints to the top 2 by score', async () => {
  const gen = genFn();
  // All three scores clear the preprint floor (0.7); one call returns all verdicts, cap trims to 2.
  gen.mockResolvedValue(batchVerdict(
    [0.95, 0.9, 0.85].map((s) => ({ faithful: true, score: s, rationale: 'r' })),
    15,
  ));
  const r = await judgeCandidates(gen, [mk('A', 'preprint'), mk('B', 'preprint'), mk('C', 'preprint')], 'preprint');
  expect(r.candidates).toHaveLength(2);
});

it('is fail-open: a judge error keeps the candidate at a neutral score (never silently dropped)', async () => {
  const gen = genFn();
  gen.mockRejectedValue(new Error('provider down'));
  const r = await judgeCandidates(gen, [mk('A')], 'rct');
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0].confidence).toBe(0.5);
});

it('counts the tokens gen spent even when the model returns unparseable JSON', async () => {
  const gen = genFn();
  // gen succeeded (real spend) but the body is not JSON. The fail-open path must still keep the
  // candidate AND report the spend — dropping it to 0 under-counts the run budget and defeats the
  // tokenBudget stop / single-lens budget-pressure collapse downstream.
  gen.mockResolvedValue({ text: 'sorry, here are my thoughts...', usage: { totalTokens: 42 }, model: 'm', latencyMs: 1 });
  const r = await judgeCandidates(gen, [mk('A')], 'rct');
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0].confidence).toBe(0.5);
  expect(r.tokens).toBe(42);
});

// ── Batch-specific tests (the three new cases from the task brief) ──────────────────────────────

it('judges all candidates in a single gen call', async () => {
  const gen = genFn();
  gen.mockResolvedValue(batchVerdict([
    { faithful: true, scopeOk: true, score: 0.9, title: 'A', technique: 'a', rationale: 'r' },
    { faithful: true, scopeOk: true, score: 0.8, title: 'B', technique: 'b', rationale: 'r' },
  ], 50));
  const out = await judgeCandidates(gen, [candA, candB], 'rct');
  expect(gen).toHaveBeenCalledTimes(1);
  expect(out.candidates).toHaveLength(2);
  expect(out.tokens).toBe(50);
});

it('falls open per-index: a missing verdict keeps that candidate at 0.5, others judged', async () => {
  const gen = genFn();
  gen.mockResolvedValue(batchVerdict([
    { faithful: true, scopeOk: true, score: 0.9, title: 'A', technique: 'a', rationale: 'r' },
    // only one verdict for two candidates — candB gets no entry
  ], 30));
  const out = await judgeCandidates(gen, [candA, candB], 'rct');
  const b = out.candidates.find((c) => c.sourceText === candB.sourceText);
  expect(b?.confidence).toBe(0.5);
  expect(b?.rationale).toBe('judge unavailable');
});

it('counts usage even when the batch body will not parse', async () => {
  const gen = genFn();
  gen.mockResolvedValue({ text: 'not json', usage: { totalTokens: 40 }, model: 'm', latencyMs: 1 });
  const out = await judgeCandidates(gen, [candA], 'rct');
  expect(out.tokens).toBe(40);
  expect(out.candidates[0].confidence).toBe(0.5);
});
