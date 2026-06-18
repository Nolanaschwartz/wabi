import { runResearch, RunDeps } from '../run';
import { Bounds, Candidate } from '../types';

const bounds: Bounds = {
  maxTopicsPerRun: 2, maxPapersPerTopic: 8, maxDiscoverySteps: 2, maxDraftsPerTopic: 3,
  maxDraftsPerRun: 3, agentTimeoutMs: 5000, runTimeoutMs: 60000, tokenBudget: 1_000_000,
};
const cand = (id: string): Candidate => ({
  title: `t${id}`, technique: `q${id}`, sourceText: 's', evidence: 'e', evidenceTier: 'rct', sourceUrl: 'u',
  source: 'PubMed', sourceId: `PMID:${id}`, sourceKind: 'pubmed', trustLevel: 'research-agent',
});

// submitBatch echoes one 'submitted' per draft it receives, so per-paper grouping is observable.
const submitAll = () => jest.fn().mockImplementation(async (cands: Candidate[]) => cands.map(() => 'submitted'));

describe('runResearch', () => {
  it('submits collected candidates and caps at maxDraftsPerRun across topics', async () => {
    const submitBatch = submitAll();
    const deps: RunDeps = {
      topics: ['a', 'b'],
      bounds,
      runAgent: jest.fn()
        .mockResolvedValueOnce({ candidates: [cand('1'), cand('2')], summary: { collected: 2 } as any, tokens: 100 })
        .mockResolvedValueOnce({ candidates: [cand('3'), cand('4')], summary: { collected: 2 } as any, tokens: 100 }),
      submitBatch,
    };
    const result = await runResearch(deps);
    // 4 distinct papers (one per sourceId), but the cap stops the 4th: 3 batch calls, 3 submitted.
    expect(submitBatch).toHaveBeenCalledTimes(3);
    expect(result.submitted).toBe(3);
  });

  it('groups multiple drafts from one paper into a single batch call', async () => {
    const submitBatch = submitAll();
    // Two drafts share sourceId PMID:1; a third is a separate paper.
    const a1 = cand('1'); const a2 = { ...cand('1'), title: 't1b', technique: 'q1b' }; const b = cand('2');
    const result = await runResearch({
      topics: ['a'], bounds: { ...bounds, maxDraftsPerRun: 10 },
      runAgent: jest.fn().mockResolvedValue({ candidates: [a1, a2, b], summary: {} as any, tokens: 0 }),
      submitBatch,
    });
    expect(submitBatch).toHaveBeenCalledTimes(2); // PMID:1 (2 drafts) + PMID:2 (1 draft)
    expect(submitBatch.mock.calls[0][0]).toHaveLength(2);
    expect(submitBatch.mock.calls[1][0]).toHaveLength(1);
    expect(result.submitted).toBe(3);
  });

  it('stops processing further topics once the run draft cap is hit', async () => {
    const submitBatch = submitAll();
    const runAgent = jest.fn().mockResolvedValue({ candidates: [cand('1'), cand('2'), cand('3')], summary: { collected: 3 } as any, tokens: 10 });
    const result = await runResearch({ topics: ['a', 'b'], bounds, runAgent, submitBatch });
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(result.submitted).toBe(3);
    expect(result.stopReason).toBe('maxDraftsPerRun');
  });

  it('stops starting new topics once runTimeoutMs is exceeded', async () => {
    let t = 0;
    const now = () => t;
    const runAgent = jest.fn().mockImplementation(async () => { t += 10_000; return { candidates: [], summary: {} as any, tokens: 0 }; });
    const submitBatch = submitAll();
    const result = await runResearch({ topics: ['a', 'b', 'c'], bounds: { ...bounds, maxTopicsPerRun: 5, runTimeoutMs: 15_000 }, runAgent, submitBatch, now });
    expect(runAgent).toHaveBeenCalledTimes(2); // 3rd topic blocked: after 2 topics clock=20_000 >= 15_000
    expect(result.stopReason).toBe('runTimeout');
  });
});
