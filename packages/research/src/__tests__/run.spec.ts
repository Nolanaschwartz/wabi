import { runResearch, RunDeps } from '../run';
import { Bounds, Candidate } from '../types';

const bounds: Bounds = {
  maxTopicsPerRun: 2, maxPapersPerTopic: 8, maxDiscoverySteps: 2, maxDraftsPerTopic: 3,
  maxDraftsPerRun: 3, agentTimeoutMs: 5000, runTimeoutMs: 60000, tokenBudget: 1_000_000,
};
const cand = (id: string): Candidate => ({
  title: `t${id}`, technique: `q${id}`, sourceText: 's', evidence: 'e', sourceUrl: 'u',
  source: 'PubMed', sourceId: `PMID:${id}`, sourceKind: 'pubmed', trustLevel: 'research-agent',
});

describe('runResearch', () => {
  it('submits collected candidates and caps at maxDraftsPerRun across topics', async () => {
    const submit = jest.fn().mockResolvedValue('submitted');
    const deps: RunDeps = {
      topics: ['a', 'b'],
      bounds,
      runAgent: jest.fn()
        .mockResolvedValueOnce({ candidates: [cand('1'), cand('2')], summary: { collected: 2 } as any, tokens: 100 })
        .mockResolvedValueOnce({ candidates: [cand('3'), cand('4')], summary: { collected: 2 } as any, tokens: 100 }),
      submit,
    };
    const result = await runResearch(deps);
    expect(submit).toHaveBeenCalledTimes(3);
    expect(result.submitted).toBe(3);
  });

  it('stops processing further topics once the run draft cap is hit', async () => {
    const submit = jest.fn().mockResolvedValue('submitted');
    const runAgent = jest.fn().mockResolvedValue({ candidates: [cand('1'), cand('2'), cand('3')], summary: { collected: 3 } as any, tokens: 10 });
    const result = await runResearch({ topics: ['a', 'b'], bounds, runAgent, submit });
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(result.submitted).toBe(3);
  });
});
