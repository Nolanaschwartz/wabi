import { ResearchAgent, AgentDeps } from '../research-agent';
import { Source } from '../../sources/source';
import { Bounds, Candidate, Paper, SourceKind } from '../../types';

const bounds: Bounds = {
  maxTopicsPerRun: 5, maxPapersPerTopic: 3, maxDiscoverySteps: 1, maxDraftsPerTopic: 2,
  maxDraftsPerRun: 10, agentTimeoutMs: 5000, runTimeoutMs: 60000, tokenBudget: 1_000_000,
};

/** A thin PubMed paper as the adapter's search() now yields it: id+kind+url, abstract filled by hydrate. */
function pubmedThin(id: string): Paper {
  return { sourceId: `PMID:${id}`, sourceKind: 'pubmed', title: '', abstract: '',
    url: `https://pubmed.ncbi.nlm.nih.gov/${id}`, pubTypes: [], isPreprint: false };
}
function psyPaper(guid: string): Paper {
  return { sourceId: `osf:${guid}`, sourceKind: 'psyarxiv', title: `PT${guid}`, abstract: `PA${guid}`,
    url: `https://osf.io/${guid}`, pubTypes: [], isPreprint: true };
}
function candidate(id: string): Candidate {
  return { title: `Tech ${id}`, technique: `do ${id}`, sourceText: `A${id}`, evidence: 'peer-reviewed: RCT',
    evidenceTier: 'rct', sourceUrl: `u${id}`, source: 'PubMed', sourceId: `PMID:${id}`, sourceKind: 'pubmed', trustLevel: 'research-agent' };
}

/** Fake PubMed Source: thin search hits, hydrate fills T/A/pubTypes, expand citation-graph (default none). */
function pubmedSource(over: Partial<Source> = {}): Source {
  return {
    kind: 'pubmed',
    search: jest.fn().mockResolvedValue([pubmedThin('1'), pubmedThin('2'), pubmedThin('3')]),
    hydrate: jest.fn(async (p: Paper) => {
      const id = p.sourceId.replace('PMID:', '');
      return { ...p, title: `T${id}`, abstract: `A${id}`, pubTypes: ['Randomized Controlled Trial'] };
    }),
    fullText: jest.fn().mockResolvedValue(null),
    expand: jest.fn().mockResolvedValue([]),
    ...over,
  } as Source;
}
/** Fake preprint Source (medRxiv/PsyArXiv): search returns complete papers, hydrate is identity, NO expand. */
function preprintSource(kind: SourceKind, over: Partial<Source> = {}): Source {
  return {
    kind,
    search: jest.fn().mockResolvedValue([]),
    hydrate: jest.fn(async (p: Paper) => p),
    fullText: jest.fn().mockResolvedValue(null),
    ...over,
  } as Source;
}

function baseDeps(over: Partial<AgentDeps> = {}, srcs: Partial<Record<SourceKind, Source>> = {}): AgentDeps {
  const sources = new Map<SourceKind, Source>([
    ['pubmed', srcs.pubmed ?? pubmedSource()],
    ['medrxiv', srcs.medrxiv ?? preprintSource('medrxiv')],
    ['psyarxiv', srcs.psyarxiv ?? preprintSource('psyarxiv')],
  ]);
  return {
    sources,
    seen: jest.fn().mockResolvedValue(false),
    gate: jest.fn().mockResolvedValue({ keep: true, tokens: 1 }),
    extract: jest.fn().mockImplementation((p: Paper) => Promise.resolve({ candidates: [candidate(p.sourceId.replace('PMID:', ''))], tokens: 10, traces: [] })),
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

  it('hydrates a thin pubmed paper before the gate, with the abstract the gate then sees', async () => {
    const gate = jest.fn().mockResolvedValue({ keep: true, tokens: 1 });
    const agent = new ResearchAgent(baseDeps({ gate }), bounds);
    await agent.run('topic');
    // hydrate populated A1/A2/A3 from the thin hits; the gate is called with the hydrated abstract.
    expect(gate).toHaveBeenCalledWith('A1');
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
    const deps = baseDeps({}, { pubmed: pubmedSource({ search: jest.fn().mockRejectedValue(new Error('PubMed HTTP 400')) }) });
    const agent = new ResearchAgent(deps, bounds, log);
    const { summary } = await agent.run('topic');
    expect(summary.searched).toBe(0);
    const fail = log.info.mock.calls.find((c) => c[0] === 'pubmed search failed');
    expect(fail).toBeTruthy();
    expect(fail![1]).toMatchObject({ err: 'PubMed HTTP 400' });
  });

  it('skips papers already seen, before hydrate/gate/extract', async () => {
    const pubmed = pubmedSource();
    const deps = baseDeps({ seen: jest.fn().mockResolvedValue(true) }, { pubmed });
    const agent = new ResearchAgent(deps, bounds);
    const { candidates, summary } = await agent.run('topic');
    expect(candidates).toHaveLength(0);
    expect(summary.seenSkipped).toBe(3);
    expect(pubmed.hydrate).not.toHaveBeenCalled();
    expect(deps.gate).not.toHaveBeenCalled();
    expect(deps.extract).not.toHaveBeenCalled();
  });

  it('checks the seen ledger with the PMID-prefixed key for a direct search hit', async () => {
    // The bot's ProcessedSource ledger is keyed `PMID:<id>`; the adapter sets that prefix in search(),
    // so a direct hit's seen() query matches the row (no bare-PMID miss → no duplicate drafts).
    const deps = baseDeps({}, { pubmed: pubmedSource({ search: jest.fn().mockResolvedValue([pubmedThin('40299806')]) }) });
    const agent = new ResearchAgent(deps, bounds);
    await agent.run('topic');
    expect(deps.seen).toHaveBeenCalledWith('PMID:40299806');
    expect(deps.seen).not.toHaveBeenCalledWith('40299806');
  });

  it('does not re-call seen for a paper already visited via discovery (in-memory set)', async () => {
    const deps = baseDeps({}, {
      pubmed: pubmedSource({
        search: jest.fn().mockResolvedValue([pubmedThin('1')]),
        expand: jest.fn().mockResolvedValue([pubmedThin('1')]),
      }),
    });
    const agent = new ResearchAgent(deps, { ...bounds, maxPapersPerTopic: 5, maxDraftsPerTopic: 5 });
    await agent.run('topic');
    // The direct hit and its discovery-expanded self share one sourceId, so the paper is checked once.
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
    const deps = baseDeps({}, {
      pubmed: pubmedSource({ search: jest.fn().mockResolvedValue([]) }),
      psyarxiv: preprintSource('psyarxiv', { search: jest.fn().mockResolvedValue([psyPaper('g1')]), fullText: psyFullText }),
      medrxiv: preprintSource('medrxiv', { fullText: medFullText }),
    });
    const agent = new ResearchAgent(deps, bounds);
    const { candidates } = await agent.run('topic');
    expect(candidates).toHaveLength(1); // the single PsyArXiv paper flowed through to a candidate
    expect(psyFullText).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'osf:g1' })); // routed by kind...
    expect(medFullText).not.toHaveBeenCalled();                                                  // ...never to medrxiv
  });

  it('falls back to the abstract when psyarxiv.fullText returns null', async () => {
    const extract = jest.fn().mockImplementation((p: Paper, body: string) =>
      Promise.resolve({ candidates: [{ ...candidate('g1'), sourceText: body }], tokens: 1, traces: [] }));
    const deps = baseDeps({ extract }, {
      pubmed: pubmedSource({ search: jest.fn().mockResolvedValue([]) }),
      psyarxiv: preprintSource('psyarxiv', { search: jest.fn().mockResolvedValue([psyPaper('g1')]), fullText: jest.fn().mockResolvedValue(null) }),
    });
    const agent = new ResearchAgent(deps, bounds);
    await agent.run('topic');
    // extract received the abstract (PAg1) as the body, proving the abstract fallback path.
    expect(extract).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'osf:g1' }), 'PAg1', expect.any(Array));
  });

  it('logs a swallowed psyarxiv search failure instead of aborting the run', async () => {
    const log = { info: jest.fn(), debug: jest.fn() };
    const deps = baseDeps({}, {
      pubmed: pubmedSource({ search: jest.fn().mockResolvedValue([]) }),
      psyarxiv: preprintSource('psyarxiv', { search: jest.fn().mockRejectedValue(new Error('OSF HTTP 503')) }),
    });
    const agent = new ResearchAgent(deps, bounds, log);
    const { summary } = await agent.run('topic');
    expect(summary.searched).toBe(0);
    const fail = log.info.mock.calls.find((c) => c[0] === 'psyarxiv search failed');
    expect(fail).toBeTruthy();
    expect(fail![1]).toMatchObject({ err: 'OSF HTTP 503' });
  });

  it('collects every distinct candidate one paper yields across lenses', async () => {
    const extract = jest.fn().mockResolvedValue({ candidates: [candidate('a'), candidate('b')], tokens: 5, traces: [] });
    const deps = baseDeps({ extract }, { pubmed: pubmedSource({ search: jest.fn().mockResolvedValue([pubmedThin('1')]) }) });
    const { candidates, summary } = await new ResearchAgent(deps, { ...bounds, maxDraftsPerTopic: 10 }).run('topic');
    expect(candidates).toHaveLength(2);
    expect(summary.extracted).toBe(2);
  });

  it('fans a peer-reviewed paper across all five lenses', async () => {
    const extract = jest.fn().mockResolvedValue({ candidates: [], tokens: 1, traces: [] });
    const deps = baseDeps({ extract }, { pubmed: pubmedSource({ search: jest.fn().mockResolvedValue([pubmedThin('1')]) }) });
    await new ResearchAgent(deps, bounds).run('topic');
    expect(extract.mock.calls[0][2]).toEqual(['behavioral', 'cognitive', 'social', 'environmental', 'physiological']);
  });

  it('collapses to a single lens under token-budget pressure (lenses fall before papers)', async () => {
    const extract = jest.fn().mockResolvedValue({ candidates: [], tokens: 0, traces: [] });
    // gate pre-spends 85 of a 100 budget, so <20% remains when the paper reaches extract.
    const deps = baseDeps({ extract, gate: jest.fn().mockResolvedValue({ keep: true, tokens: 85 }) },
      { pubmed: pubmedSource({ search: jest.fn().mockResolvedValue([pubmedThin('1')]) }) });
    await new ResearchAgent(deps, { ...bounds, tokenBudget: 100 }).run('topic');
    expect(extract.mock.calls[0][2]).toHaveLength(1);
  });

  it('continues when one paper errors (fail-open-empty)', async () => {
    const deps = baseDeps({
      extract: jest.fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockImplementation((p: Paper) => Promise.resolve({ candidates: [candidate(p.sourceId.replace('PMID:', ''))], tokens: 10, traces: [] })),
    });
    const agent = new ResearchAgent(deps, bounds);
    const { summary } = await agent.run('topic');
    expect(summary.errors).toBe(1);
    expect(summary.collected).toBeGreaterThanOrEqual(1);
  });
});
