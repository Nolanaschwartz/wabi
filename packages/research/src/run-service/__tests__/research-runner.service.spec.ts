import { ResearchRunnerService } from '../research-runner.service';
import type { RunDeps, RunResult } from '../../run';
import type { Bounds, Candidate } from '../../types';

const bounds: Bounds = {
  maxTopicsPerRun: 5, maxPapersPerTopic: 8, maxDiscoverySteps: 2, maxDraftsPerTopic: 3,
  maxDraftsPerRun: 10, agentTimeoutMs: 90_000, runTimeoutMs: 600_000, tokenBudget: 200_000,
};

const cand = (id: string): Candidate => ({
  title: `t${id}`, technique: `q${id}`, sourceText: 's', evidence: 'e', evidenceTier: 'rct', sourceUrl: 'u',
  source: 'PubMed', sourceId: `PMID:${id}`, sourceKind: 'pubmed', trustLevel: 'research-agent',
});

describe('ResearchRunnerService', () => {
  it('maps the core RunResult + tracked totals onto a RunnerResult (success summary mapping)', async () => {
    const runResult: RunResult = {
      submitted: 4, deduped: 2, rejected: 1, errors: 0, collected: 7, stopReason: 'maxDraftsPerRun',
    };
    const runFn = jest.fn().mockResolvedValue(runResult);
    const buildAgent = jest.fn().mockReturnValue({
      runAgent: jest.fn(),
      submitBatch: jest.fn(),
      tokens: () => 12_345,
      topicsRun: () => 3,
    });

    const svc = new ResearchRunnerService({ runFn, buildAgent });
    const result = await svc.execute({ bounds, topics: ['a', 'b', 'c'] });

    expect(result).toEqual({
      submitted: 4, deduped: 2, rejected: 1, errors: 0, collected: 7,
      stopReason: 'maxDraftsPerRun', tokensUsed: 12_345, topicsRun: 3,
    });
  });

  it('drives the core with the DB-sourced topics + bounds and the built agent/submit closures', async () => {
    const runAgent = jest.fn();
    const submitBatch = jest.fn();
    const buildAgent = jest.fn().mockReturnValue({ runAgent, submitBatch, tokens: () => 0, topicsRun: () => 0 });
    let captured: RunDeps | undefined;
    const runFn = jest.fn().mockImplementation((deps: RunDeps) => {
      captured = deps;
      return Promise.resolve({ submitted: 0, deduped: 0, rejected: 0, errors: 0, collected: 0, stopReason: 'exhausted' });
    });

    const svc = new ResearchRunnerService({ runFn, buildAgent });
    await svc.execute({ bounds, topics: ['stress', 'sleep'] });

    expect(buildAgent).toHaveBeenCalledWith(bounds, expect.anything());
    expect(captured?.topics).toEqual(['stress', 'sleep']);
    expect(captured?.bounds).toBe(bounds);
    expect(captured?.runAgent).toBe(runAgent);
    expect(captured?.submitBatch).toBe(submitBatch);
  });

  it('propagates a thrown core error to the caller (the consumer maps it onto a failed row)', async () => {
    const runFn = jest.fn().mockRejectedValue(new Error('boom'));
    const buildAgent = jest.fn().mockReturnValue({
      runAgent: jest.fn(), submitBatch: jest.fn(), tokens: () => 0, topicsRun: () => 0,
    });

    const svc = new ResearchRunnerService({ runFn, buildAgent });
    await expect(svc.execute({ bounds, topics: ['a'] })).rejects.toThrow('boom');
  });

  it('accumulates real tokensUsed/topicsRun from the agent closures across topics', async () => {
    // A real-ish buildAgent: runAgent returns candidates + tokens; we exercise the default-style
    // accumulation via the seam (no network — fakes only).
    let tokensUsed = 0;
    let topicsRun = 0;
    const buildAgent = jest.fn().mockReturnValue({
      runAgent: async (_topic: string) => { topicsRun++; tokensUsed += 100; return { candidates: [cand('1')], tokens: 100 }; },
      submitBatch: jest.fn().mockResolvedValue(['submitted']),
      tokens: () => tokensUsed,
      topicsRun: () => topicsRun,
    });

    // Use the REAL core so runAgent/submit actually fire.
    const svc = new ResearchRunnerService({ buildAgent });
    const result = await svc.execute({ bounds, topics: ['a', 'b'] });

    expect(result.topicsRun).toBe(2);
    expect(result.tokensUsed).toBe(200);
    expect(result.submitted).toBe(2);
  });
});
