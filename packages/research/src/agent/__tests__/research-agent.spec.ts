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
function psyPaper(guid: string): Paper {
  return { sourceId: `osf:${guid}`, sourceKind: 'psyarxiv', title: `PT${guid}`, abstract: `PA${guid}`,
    url: `https://osf.io/${guid}`, pubTypes: [], isPreprint: true };
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
    psyarxiv: { search: jest.fn().mockResolvedValue([]), fullText: jest.fn().mockResolvedValue(null) } as any,
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

  it('logs a swallowed pubmed search failure instead of hiding it as zero results', async () => {
    const log = { info: jest.fn(), debug: jest.fn() };
    const deps = baseDeps({
      pubmed: { ...baseDeps().pubmed, search: jest.fn().mockRejectedValue(new Error('PubMed HTTP 400')) } as any,
    });
    const agent = new ResearchAgent(deps, bounds, log);
    const { summary } = await agent.run('topic');
    expect(summary.searched).toBe(0);
    const fail = log.info.mock.calls.find((c) => c[0] === 'pubmed search failed');
    expect(fail).toBeTruthy();
    expect(fail![1]).toMatchObject({ err: 'PubMed HTTP 400' });
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

  it('checks the seen ledger with the PMID-prefixed key for a direct search hit', async () => {
    // The bot's ProcessedSource ledger is keyed `PMID:<id>` (extract sets sourceId=`PMID:<id>`,
    // which strategy-admin.markProcessed stores). A bare-PMID seen() query never matches that row,
    // so the paper is re-submitted every run → duplicate pending-review StrategyDrafts.
    const deps = baseDeps({
      pubmed: { ...baseDeps().pubmed, search: jest.fn().mockResolvedValue(['40299806']) } as any,
    });
    const agent = new ResearchAgent(deps, bounds);
    await agent.run('topic');
    expect(deps.seen).toHaveBeenCalledWith('PMID:40299806');
    expect(deps.seen).not.toHaveBeenCalledWith('40299806');
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
    // The direct hit and its discovery-expanded self share one key, so the paper is checked once.
    expect((deps.seen as jest.Mock).mock.calls.filter((c) => c[0] === 'PMID:1')).toHaveLength(1);
    expect(deps.seen).toHaveBeenCalledTimes(1);
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

  it('queues and processes PsyArXiv papers, calling psyarxiv.fullText (never medrxiv.fullText) for them', async () => {
    const psyFullText = jest.fn().mockResolvedValue(null);
    const medFullText = jest.fn().mockResolvedValue(null);
    const deps = baseDeps({
      pubmed: { ...baseDeps().pubmed, search: jest.fn().mockResolvedValue([]) } as any,
      psyarxiv: { search: jest.fn().mockResolvedValue([psyPaper('g1')]), fullText: psyFullText } as any,
      medrxiv: { search: jest.fn().mockResolvedValue([]), fullText: medFullText } as any,
    });
    const agent = new ResearchAgent(deps, bounds);
    const { candidates } = await agent.run('topic');
    expect(candidates).toHaveLength(1); // the single PsyArXiv paper flowed through to a candidate
    expect(psyFullText).toHaveBeenCalledWith('osf:g1'); // routed to psyarxiv by kind...
    expect(medFullText).not.toHaveBeenCalled();          // ...never to medrxiv
  });

  it('falls back to the abstract when psyarxiv.fullText returns null', async () => {
    const extract = jest.fn().mockImplementation((p: Paper, body: string) =>
      Promise.resolve({ candidate: { ...candidate('g1'), sourceText: body }, tokens: 1 }));
    const deps = baseDeps({
      pubmed: { ...baseDeps().pubmed, search: jest.fn().mockResolvedValue([]) } as any,
      psyarxiv: { search: jest.fn().mockResolvedValue([psyPaper('g1')]), fullText: jest.fn().mockResolvedValue(null) } as any,
      extract,
    });
    const agent = new ResearchAgent(deps, bounds);
    await agent.run('topic');
    // extract received the abstract (PAg1) as the body, proving the abstract fallback path.
    expect(extract).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'osf:g1' }), 'PAg1');
  });

  it('logs a swallowed psyarxiv search failure instead of aborting the run', async () => {
    const log = { info: jest.fn(), debug: jest.fn() };
    const deps = baseDeps({
      pubmed: { ...baseDeps().pubmed, search: jest.fn().mockResolvedValue([]) } as any,
      psyarxiv: { search: jest.fn().mockRejectedValue(new Error('OSF HTTP 503')), fullText: jest.fn() } as any,
    });
    const agent = new ResearchAgent(deps, bounds, log);
    const { summary } = await agent.run('topic');
    expect(summary.searched).toBe(0);
    const fail = log.info.mock.calls.find((c) => c[0] === 'psyarxiv search failed');
    expect(fail).toBeTruthy();
    expect(fail![1]).toMatchObject({ err: 'OSF HTTP 503' });
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
