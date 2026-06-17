import { ResearchAgent, AgentDeps } from '../research-agent';
import { Bounds, Candidate, Paper } from '../../types';

const bounds: Bounds = {
  maxTopicsPerRun: 5, maxPapersPerTopic: 3, maxDiscoverySteps: 1, maxDraftsPerTopic: 2,
  maxDraftsPerRun: 10, agentTimeoutMs: 5000, runTimeoutMs: 60000, tokenBudget: 1_000_000,
};

function paper(id: string): Paper {
  return { sourceId: `PMID:${id}`, sourceKind: 'pubmed', title: `T${id}`, abstract: `A${id}`,
    url: `u${id}`, pubTypes: ['Randomized Controlled Trial'], isPreprint: false };
}
function candidate(id: string): Candidate {
  return { title: `Tech ${id}`, technique: `do ${id}`, sourceText: `A${id}`, evidence: 'peer-reviewed: RCT',
    sourceUrl: `u${id}`, source: 'PubMed', sourceId: `PMID:${id}`, sourceKind: 'pubmed', trustLevel: 'research-agent' };
}

function baseDeps(over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    pubmed: {
      search: jest.fn().mockResolvedValue(['1', '2', '3']),
      summary: jest.fn().mockImplementation((id: string) => Promise.resolve({ title: `T${id}`, pubTypes: ['Randomized Controlled Trial'] })),
      abstract: jest.fn().mockImplementation((id: string) => Promise.resolve(`A${id}`)),
      related: jest.fn().mockResolvedValue([]),
      fullText: jest.fn().mockResolvedValue(null),
    } as any,
    medrxiv: { search: jest.fn().mockResolvedValue([]), fullText: jest.fn().mockResolvedValue(null) } as any,
    seen: jest.fn().mockResolvedValue(false),
    gate: jest.fn().mockResolvedValue({ keep: true, tokens: 1 }),
    extract: jest.fn().mockImplementation((p: Paper) => Promise.resolve({ candidate: candidate(p.sourceId.replace('PMID:', '')), tokens: 10 })),
    dedup: jest.fn().mockResolvedValue({ duplicate: false, tokens: 0 }),
    ...over,
  };
}

describe('ResearchAgent', () => {
  it('collects distinct candidates up to maxDraftsPerTopic', async () => {
    const agent = new ResearchAgent(baseDeps(), bounds);
    const { candidates, summary } = await agent.run('topic');
    expect(candidates).toHaveLength(2);
    expect(summary.collected).toBe(2);
    expect(summary.stopReason).toBe('maxDraftsPerTopic');
  });

  it('emits progress through the injected logger (topic start + collected + topic done)', async () => {
    const log = { info: jest.fn(), debug: jest.fn() };
    const agent = new ResearchAgent(baseDeps(), bounds, log);
    await agent.run('topic');
    const msgs = log.info.mock.calls.map((c) => c[0]);
    expect(msgs).toContain('topic start');
    expect(msgs).toContain('collected');
    expect(msgs).toContain('topic done');
  });

  it('skips papers already seen, before gate/extract', async () => {
    const deps = baseDeps({ seen: jest.fn().mockResolvedValue(true) });
    const agent = new ResearchAgent(deps, bounds);
    const { candidates, summary } = await agent.run('topic');
    expect(candidates).toHaveLength(0);
    expect(summary.seenSkipped).toBe(3);
    expect(deps.gate).not.toHaveBeenCalled();
    expect(deps.extract).not.toHaveBeenCalled();
  });

  it('does not re-call seen for a paper already visited via discovery (in-memory set)', async () => {
    const deps = baseDeps({
      pubmed: { ...baseDeps().pubmed,
        search: jest.fn().mockResolvedValue(['1']),
        related: jest.fn().mockResolvedValue(['1']),
      } as any,
    });
    const agent = new ResearchAgent(deps, { ...bounds, maxPapersPerTopic: 5, maxDraftsPerTopic: 5 });
    await agent.run('topic');
    expect((deps.seen as jest.Mock).mock.calls.filter((c) => c[0] === 'PMID:1')).toHaveLength(1);
  });

  it('drops in-run duplicates and keeps reading for a novel one', async () => {
    const deps = baseDeps({
      dedup: jest.fn()
        .mockResolvedValueOnce({ duplicate: false, tokens: 0 })
        .mockResolvedValueOnce({ duplicate: true, tokens: 0 })
        .mockResolvedValueOnce({ duplicate: false, tokens: 0 }),
    });
    const agent = new ResearchAgent(deps, bounds);
    const { candidates, summary } = await agent.run('topic');
    expect(candidates).toHaveLength(2);
    expect(summary.inRunDeduped).toBe(1);
  });

  it('continues when one paper errors (fail-open-empty)', async () => {
    const deps = baseDeps({
      extract: jest.fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockImplementation((p: Paper) => Promise.resolve({ candidate: candidate(p.sourceId.replace('PMID:', '')), tokens: 10 })),
    });
    const agent = new ResearchAgent(deps, bounds);
    const { summary } = await agent.run('topic');
    expect(summary.errors).toBe(1);
    expect(summary.collected).toBeGreaterThanOrEqual(1);
  });
});
