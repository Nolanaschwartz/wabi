// isDuplicateInRun is now a caller of @wabi/shared/generate. The MECHANISM (provider resolution, ai
// client, the call) moved into generate; what stays here and is tested is dedup's DOMAIN logic — the
// Jaccard prefilter that short-circuits the clear cases, the "same" parse, and its fail policy
// (error/empty -> not-a-duplicate, the safe direction).
jest.mock('@wabi/shared/generate', () => ({ generate: jest.fn() }));

import { isDuplicateInRun } from '../dedup';
import { Candidate } from '../../types';

const mk = (title: string, technique: string): Candidate => ({
  title, technique, sourceText: 's', evidence: 'e', evidenceTier: 'rct', sourceUrl: 'u',
  source: 'PubMed', sourceId: 'PMID:x', sourceKind: 'pubmed', trustLevel: 'research-agent',
});

describe('isDuplicateInRun', () => {
  const { generate } = require('@wabi/shared/generate') as { generate: jest.Mock };
  // generate returns { text, usage, model, latencyMs }; dedup reads text + usage.totalTokens.
  const reply = (text: string, totalTokens?: number) => ({
    text,
    usage: totalTokens === undefined ? undefined : { totalTokens },
    model: 'm',
    latencyMs: 1,
  });
  beforeEach(() => jest.clearAllMocks());

  it('distinct when there is nothing kept yet (no LLM call)', async () => {
    const r = await isDuplicateInRun(mk('Box Breathing', 'inhale hold exhale'), []);
    expect(r.duplicate).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });

  it('duplicate via lexical overlap without an LLM call', async () => {
    const kept = [mk('Progressive muscle relaxation', 'tense and release major muscle groups')];
    const r = await isDuplicateInRun(mk('Progressive muscle relaxation', 'tense and release major muscle groups'), kept);
    expect(r.duplicate).toBe(true);
    expect(generate).not.toHaveBeenCalled();
  });

  it('distinct via near-zero lexical overlap without an LLM call', async () => {
    const kept = [mk('Box Breathing', 'inhale hold exhale to calm down')];
    const r = await isDuplicateInRun(mk('Gratitude journaling', 'write three good things nightly'), kept);
    expect(r.duplicate).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });

  it('uses the LLM to confirm an ambiguous middle case', async () => {
    generate.mockResolvedValue(reply('same', 6));
    const kept = [mk('Box Breathing', 'inhale 4 hold 4 exhale 4 to calm down')];
    const r = await isDuplicateInRun(mk('Square breathing drill', 'four-count breathing to reduce arousal'), kept);
    expect(generate).toHaveBeenCalled();
    expect(r.duplicate).toBe(true);
    expect(r.tokens).toBe(6);
  });

  it('not a duplicate when the LLM says different', async () => {
    generate.mockResolvedValue(reply('different', 7));
    const kept = [mk('Box Breathing', 'inhale 4 hold 4 exhale 4 to calm down')];
    const r = await isDuplicateInRun(mk('Square breathing drill', 'four-count breathing to reduce arousal'), kept);
    expect(generate).toHaveBeenCalled();
    expect(r.duplicate).toBe(false);
  });

  it('uses role "research-triage" and opts out of retry-on-empty', async () => {
    generate.mockResolvedValue(reply('same', 6));
    const kept = [mk('Box Breathing', 'inhale 4 hold 4 exhale 4 to calm down')];
    await isDuplicateInRun(mk('Square breathing drill', 'four-count breathing to reduce arousal'), kept);
    expect(generate.mock.calls[0][0]).toBe('research-triage');
    expect(generate.mock.calls[0][1].retryOnEmpty).toBeUndefined();
  });

  it('not a duplicate when generate throws (transport failure) — dedup owns the fail policy', async () => {
    generate.mockRejectedValue(new Error('ECONNREFUSED'));
    const kept = [mk('Box Breathing', 'inhale 4 hold 4 exhale 4 to calm down')];
    const r = await isDuplicateInRun(mk('Square breathing drill', 'four-count breathing to reduce arousal'), kept);
    expect(r.duplicate).toBe(false);
    expect(r.tokens).toBe(0);
  });

  it('not a duplicate on EMPTY output — a reasoning model starved by the cap returns ""', async () => {
    generate.mockResolvedValue(reply('', 480));
    const kept = [mk('Box Breathing', 'inhale 4 hold 4 exhale 4 to calm down')];
    const r = await isDuplicateInRun(mk('Square breathing drill', 'four-count breathing to reduce arousal'), kept);
    expect(r.duplicate).toBe(false);
    expect(r.tokens).toBe(480);
  });

  it('requests an output budget large enough for a reasoning model to answer the ambiguous case', async () => {
    generate.mockResolvedValue(reply('same', 6));
    const kept = [mk('Box Breathing', 'inhale 4 hold 4 exhale 4 to calm down')];
    await isDuplicateInRun(mk('Square breathing drill', 'four-count breathing to reduce arousal'), kept);
    expect(generate.mock.calls[0][1].maxOutputTokens).toBeGreaterThanOrEqual(1000);
  });
});
