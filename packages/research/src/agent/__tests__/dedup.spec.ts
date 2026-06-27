// isDuplicateInRun is now embed-first. The MECHANISM (cosine comparison over in-flight embeddings)
// replaces the old jaccard band + LLM path. What stays tested: the cosine duplicate/distinct judgment,
// the empty-embedding fallback to lexical ceiling, and the zero-kept short-circuit.
import { isDuplicateInRun } from '../dedup';
import { Candidate } from '../../types';
import type { ResearchGenerate } from '../research-generate';
import * as embedMod from '@wabi/shared/embed';

const mk = (title: string, technique: string): Candidate => ({
  title, technique, sourceText: 's', evidence: 'e', evidenceTier: 'rct', sourceUrl: 'u',
  source: 'PubMed', sourceId: 'PMID:x', sourceKind: 'pubmed', trustLevel: 'research-agent',
});

// gen is unused in the embed-first path; kept in signature for call-site stability.
const genFn = (): jest.MockedFunction<ResearchGenerate> => jest.fn() as jest.MockedFunction<ResearchGenerate>;

// Shared fixtures for cosine tests — content doesn't matter; embed is mocked.
const candA = mk('Box Breathing', 'inhale hold exhale');
const candB = mk('Progressive muscle relaxation', 'tense and release');

// Fixtures with enough token overlap to clear the lexical ceiling (jaccard ≥ SIM_CEIL = 0.6).
// Identical sigs → jaccard 1.0 — used to verify the lexical fallback branch.
const candHigh = mk('Progressive muscle relaxation', 'tense and release major muscle groups');
const candHighDup = mk('Progressive muscle relaxation', 'tense and release major muscle groups');

describe('isDuplicateInRun', () => {
  const noopGen = genFn();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('distinct when there is nothing kept yet (no embed call)', async () => {
    const spy = jest.spyOn(embedMod, 'embed');
    const r = await isDuplicateInRun(noopGen, mk('Box Breathing', 'inhale hold exhale'), []);
    expect(r.duplicate).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('marks a candidate duplicate when cosine >= threshold', async () => {
    jest.spyOn(embedMod, 'embed').mockResolvedValue([1, 0, 0]); // identical vectors → cosine 1.0
    const out = await isDuplicateInRun(noopGen, candA, [candB]);
    expect(out.duplicate).toBe(true);
    expect(out.tokens).toBe(0);
  });

  it('marks distinct when cosine < threshold', async () => {
    const calls = [[1, 0, 0], [0, 1, 0]]; // orthogonal → cosine 0
    jest.spyOn(embedMod, 'embed').mockImplementation(async () => calls.shift()!);
    const out = await isDuplicateInRun(noopGen, candA, [candB]);
    expect(out.duplicate).toBe(false);
  });

  it('falls back to lexical jaccard when embed returns []', async () => {
    jest.spyOn(embedMod, 'embed').mockResolvedValue([]);
    // candHigh and candHighDup share enough tokens to clear the lexical HIGH ceiling
    const out = await isDuplicateInRun(noopGen, candHigh, [candHighDup]);
    expect(out.duplicate).toBe(true);
  });

  it('falls back to distinct (not duplicate) on empty embed when tokens are below lexical ceiling', async () => {
    jest.spyOn(embedMod, 'embed').mockResolvedValue([]);
    // near-zero overlap — below SIM_CEIL → lexical fallback resolves distinct
    const out = await isDuplicateInRun(noopGen, mk('Gratitude journaling', 'write three good things'), [mk('Box Breathing', 'inhale hold exhale')]);
    expect(out.duplicate).toBe(false);
  });
});
