// isDuplicateInRun is now a caller of the injected `gen` seam. The MECHANISM (role→cap binding, provider
// resolution, the call, span emission) lives in `gen`; what stays here and is tested is dedup's DOMAIN
// logic — the Jaccard prefilter that short-circuits the clear cases, the "same" parse, and its fail
// policy (error/empty -> not-a-duplicate, the safe direction).
import { isDuplicateInRun } from '../dedup';
import { Candidate } from '../../types';
import type { ResearchGenerate } from '../research-generate';
import type { GenerateResult } from '@wabi/shared/generate';

const mk = (title: string, technique: string): Candidate => ({
  title, technique, sourceText: 's', evidence: 'e', evidenceTier: 'rct', sourceUrl: 'u',
  source: 'PubMed', sourceId: 'PMID:x', sourceKind: 'pubmed', trustLevel: 'research-agent',
});

describe('isDuplicateInRun', () => {
  // gen returns { text, usage, model, latencyMs }; dedup reads text + usage.totalTokens.
  const reply = (text: string, totalTokens?: number): GenerateResult => ({
    text,
    usage: totalTokens === undefined ? undefined : { totalTokens },
    model: 'm',
    latencyMs: 1,
  });
  const genFn = (): jest.MockedFunction<ResearchGenerate> => jest.fn() as jest.MockedFunction<ResearchGenerate>;

  it('distinct when there is nothing kept yet (no LLM call)', async () => {
    const gen = genFn();
    const r = await isDuplicateInRun(gen, mk('Box Breathing', 'inhale hold exhale'), []);
    expect(r.duplicate).toBe(false);
    expect(gen).not.toHaveBeenCalled();
  });

  it('duplicate via lexical overlap without an LLM call', async () => {
    const gen = genFn();
    const kept = [mk('Progressive muscle relaxation', 'tense and release major muscle groups')];
    const r = await isDuplicateInRun(gen, mk('Progressive muscle relaxation', 'tense and release major muscle groups'), kept);
    expect(r.duplicate).toBe(true);
    expect(gen).not.toHaveBeenCalled();
  });

  it('distinct via near-zero lexical overlap without an LLM call', async () => {
    const gen = genFn();
    const kept = [mk('Box Breathing', 'inhale hold exhale to calm down')];
    const r = await isDuplicateInRun(gen, mk('Gratitude journaling', 'write three good things nightly'), kept);
    expect(r.duplicate).toBe(false);
    expect(gen).not.toHaveBeenCalled();
  });

  it('does NOT escalate a one-shared-word pair to the LLM (raised floor vs the old 0.05)', async () => {
    const gen = genFn();
    const kept = [mk('Box breathing', 'inhale slowly')];
    const r = await isDuplicateInRun(gen, mk('Walking outdoors', 'walk outdoors and inhale fresh air'), kept);
    expect(r.duplicate).toBe(false);
    expect(gen).not.toHaveBeenCalled();
  });

  it('uses the LLM to confirm an ambiguous middle case', async () => {
    const gen = genFn();
    gen.mockResolvedValue(reply('same', 6));
    const kept = [mk('Box Breathing', 'inhale 4 hold 4 exhale 4 to calm down')];
    const r = await isDuplicateInRun(gen, mk('Square breathing drill', 'four-count breathing to reduce arousal'), kept);
    expect(gen).toHaveBeenCalled();
    expect(r.duplicate).toBe(true);
    expect(r.tokens).toBe(6);
  });

  it('not a duplicate when the LLM says different', async () => {
    const gen = genFn();
    gen.mockResolvedValue(reply('different', 7));
    const kept = [mk('Box Breathing', 'inhale 4 hold 4 exhale 4 to calm down')];
    const r = await isDuplicateInRun(gen, mk('Square breathing drill', 'four-count breathing to reduce arousal'), kept);
    expect(gen).toHaveBeenCalled();
    expect(r.duplicate).toBe(false);
  });

  it('calls gen with span "dedup" and role "research-triage"', async () => {
    const gen = genFn();
    gen.mockResolvedValue(reply('same', 6));
    const kept = [mk('Box Breathing', 'inhale 4 hold 4 exhale 4 to calm down')];
    await isDuplicateInRun(gen, mk('Square breathing drill', 'four-count breathing to reduce arousal'), kept);
    expect(gen.mock.calls[0][0]).toBe('dedup');
    expect(gen.mock.calls[0][1]).toBe('research-triage');
  });

  it('not a duplicate when gen throws (transport failure) — dedup owns the fail policy', async () => {
    const gen = genFn();
    gen.mockRejectedValue(new Error('ECONNREFUSED'));
    const kept = [mk('Box Breathing', 'inhale 4 hold 4 exhale 4 to calm down')];
    const r = await isDuplicateInRun(gen, mk('Square breathing drill', 'four-count breathing to reduce arousal'), kept);
    expect(r.duplicate).toBe(false);
    expect(r.tokens).toBe(0);
  });

  it('not a duplicate on EMPTY output — a reasoning model starved by the cap returns ""', async () => {
    const gen = genFn();
    gen.mockResolvedValue(reply('', 480));
    const kept = [mk('Box Breathing', 'inhale 4 hold 4 exhale 4 to calm down')];
    const r = await isDuplicateInRun(gen, mk('Square breathing drill', 'four-count breathing to reduce arousal'), kept);
    expect(r.duplicate).toBe(false);
    expect(r.tokens).toBe(480);
  });
});
