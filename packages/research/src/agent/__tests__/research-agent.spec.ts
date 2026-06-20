import { ResearchAgent, AgentDeps, ExtractionPipeline } from '../research-agent';
import { Source } from '../../sources/source';
import { Bounds, Candidate, Paper, SourceKind } from '../../types';

const bounds: Bounds = {
  maxTopicsPerRun: 5, maxPapersPerTopic: 3, searchLimit: 40, maxDiscoverySteps: 1, maxDraftsPerTopic: 2,
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
/** Fake preprint Source (Europe PMC/PsyArXiv): search returns complete papers, hydrate is identity, NO expand. */
function preprintSource(kind: SourceKind, over: Partial<Source> = {}): Source {
  return {
    kind,
    search: jest.fn().mockResolvedValue([]),
    hydrate: jest.fn(async (p: Paper) => p),
    fullText: jest.fn().mockResolvedValue(null),
    ...over,
  } as Source;
}

/** The orchestration test stubs the single `pipeline` collaborator (issue 02): one fake object whose five
 * methods are jest.fns. Sequencing, budget stops, lens selection, and cross-paper dedup are all asserted
 * against this one stub, never against five separate deps. Overrides per test replace just the method(s)
 * that test drives. */
function fakePipeline(over: Partial<ExtractionPipeline> = {}): ExtractionPipeline {
  return {
    gate: jest.fn().mockResolvedValue({ keep: true, tokens: 1 }),
    extract: jest.fn().mockImplementation((_gen, p: Paper) => Promise.resolve({ candidates: [candidate(p.sourceId.replace('PMID:', ''))], tokens: 10 })),
    merge: jest.fn().mockImplementation((_gen, cands: Candidate[]) => Promise.resolve({ candidates: cands, tokens: 0 })),
    judge: jest.fn().mockImplementation((_gen, cands: Candidate[]) => Promise.resolve({ candidates: cands, tokens: 0 })),
    dedup: jest.fn().mockResolvedValue({ duplicate: false, tokens: 0 }),
    ...over,
  };
}

/** The non-pipeline seams a test can override (sources/buildConcepts/seen/markGated). The five step fns
 * are overridden through `pipe` instead, which is grouped into the single `pipeline` collaborator. */
function baseDeps(
  over: Partial<Omit<AgentDeps, 'pipeline'>> = {},
  srcs: Partial<Record<SourceKind, Source>> = {},
  pipe: Partial<ExtractionPipeline> = {},
): AgentDeps {
  const sources = new Map<SourceKind, Source>([
    ['pubmed', srcs.pubmed ?? pubmedSource()],
    ['europepmc', srcs.europepmc ?? preprintSource('europepmc')],
    ['psyarxiv', srcs.psyarxiv ?? preprintSource('psyarxiv')],
  ]);
  return {
    sources,
    buildConcepts: jest.fn().mockResolvedValue({ core: ['emotion regulation'], context: [] }),
    seen: jest.fn().mockResolvedValue(false),
    markGated: jest.fn().mockResolvedValue(undefined),
    pipeline: fakePipeline(pipe),
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
    const agent = new ResearchAgent(baseDeps({}, {}, { gate }), bounds);
    await agent.run('topic');
    // hydrate populated A1/A2/A3 from the thin hits; the gate is called with gen + the hydrated abstract + topic.
    expect(gate).toHaveBeenCalledWith(expect.any(Function), 'A1', 'topic');
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
    expect(deps.pipeline.gate).not.toHaveBeenCalled();
    expect(deps.pipeline.extract).not.toHaveBeenCalled();
  });

  it('pre-screens a clearly out-of-scope abstract: dropped before the gate, no gate LLM call', async () => {
    const pubmed = pubmedSource({
      search: jest.fn().mockResolvedValue([pubmedThin('40299806')]),
      hydrate: jest.fn(async (p: Paper) => ({ ...p, title: 'T', abstract: 'Vitamin D supplementation improved mood.', pubTypes: ['Randomized Controlled Trial'] })),
    });
    const deps = baseDeps({}, { pubmed });
    const agent = new ResearchAgent(deps, bounds);
    const { summary } = await agent.run('topic');
    expect(deps.pipeline.gate).not.toHaveBeenCalled();
    expect(deps.pipeline.extract).not.toHaveBeenCalled();
    expect(summary.gatedOut).toBe(1);
    // NOT negative-cached: a blunt-keyword prescreen drop must stay reversible (fail-open mining,
    // ADR-0021) so an in-scope paper that merely mentions a supplement isn't permanently blacklisted.
    expect(deps.markGated).not.toHaveBeenCalled();
  });

  it('negative-caches a gated-out paper (markGated with sourceId + kind) so it is not re-gated next run', async () => {
    const pubmed = pubmedSource({ search: jest.fn().mockResolvedValue([pubmedThin('40299806')]) });
    const deps = baseDeps({}, { pubmed }, { gate: jest.fn().mockResolvedValue({ keep: false, tokens: 1 }) });
    const agent = new ResearchAgent(deps, bounds);
    const { summary } = await agent.run('topic');
    expect(summary.gatedOut).toBe(1);
    expect(deps.markGated).toHaveBeenCalledWith('PMID:40299806', 'pubmed');
    expect(deps.pipeline.extract).not.toHaveBeenCalled();
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
    const deps = baseDeps({}, {}, {
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

  it('queues and processes PsyArXiv papers, calling psyarxiv.fullText (never europepmc.fullText) for them', async () => {
    const psyFullText = jest.fn().mockResolvedValue(null);
    const epmcFullText = jest.fn().mockResolvedValue(null);
    const deps = baseDeps({}, {
      pubmed: pubmedSource({ search: jest.fn().mockResolvedValue([]) }),
      psyarxiv: preprintSource('psyarxiv', { search: jest.fn().mockResolvedValue([psyPaper('g1')]), fullText: psyFullText }),
      europepmc: preprintSource('europepmc', { fullText: epmcFullText }),
    });
    const agent = new ResearchAgent(deps, bounds);
    const { candidates } = await agent.run('topic');
    expect(candidates).toHaveLength(1); // the single PsyArXiv paper flowed through to a candidate
    expect(psyFullText).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'osf:g1' })); // routed by kind...
    expect(epmcFullText).not.toHaveBeenCalled();                                                // ...never to europepmc
  });

  it('falls back to the abstract when psyarxiv.fullText returns null', async () => {
    const extract = jest.fn().mockImplementation((_gen, _p: Paper, body: string) =>
      Promise.resolve({ candidates: [{ ...candidate('g1'), sourceText: body }], tokens: 1 }));
    const deps = baseDeps({}, {
      pubmed: pubmedSource({ search: jest.fn().mockResolvedValue([]) }),
      psyarxiv: preprintSource('psyarxiv', { search: jest.fn().mockResolvedValue([psyPaper('g1')]), fullText: jest.fn().mockResolvedValue(null) }),
    }, { extract });
    const agent = new ResearchAgent(deps, bounds);
    await agent.run('topic');
    // extract received the abstract (PAg1) as the body, proving the abstract fallback path.
    expect(extract).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ sourceId: 'osf:g1' }), 'PAg1', expect.any(Array));
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
    const extract = jest.fn().mockResolvedValue({ candidates: [candidate('a'), candidate('b')], tokens: 5 });
    const deps = baseDeps({}, { pubmed: pubmedSource({ search: jest.fn().mockResolvedValue([pubmedThin('1')]) }) }, { extract });
    const { candidates, summary } = await new ResearchAgent(deps, { ...bounds, maxDraftsPerTopic: 10 }).run('topic');
    expect(candidates).toHaveLength(2);
    expect(summary.extracted).toBe(2);
  });

  it('runs within-paper merge on the extracted candidates before dedup, keeping only the distinct set', async () => {
    const extract = jest.fn().mockResolvedValue({ candidates: [candidate('a'), candidate('b')], tokens: 5 });
    // merge collapses the two lens hits into one technique.
    const merge = jest.fn().mockImplementation((_gen, cands: Candidate[]) => Promise.resolve({ candidates: [cands[0]], tokens: 2 }));
    const deps = baseDeps({}, { pubmed: pubmedSource({ search: jest.fn().mockResolvedValue([pubmedThin('1')]) }) }, { extract, merge });
    const { candidates, summary } = await new ResearchAgent(deps, { ...bounds, maxDraftsPerTopic: 10 }).run('topic');
    expect(merge).toHaveBeenCalledWith(expect.any(Function), [candidate('a'), candidate('b')]);
    expect(candidates).toHaveLength(1);
    expect(summary.extracted).toBe(1);
  });

  it('judges merged candidates with the paper tier and collects only the survivors', async () => {
    const extract = jest.fn().mockResolvedValue({ candidates: [candidate('a'), candidate('b')], tokens: 5 });
    // judge drops one and keeps the other with a confidence score.
    const judge = jest.fn().mockImplementation((_gen, cands: Candidate[]) =>
      Promise.resolve({ candidates: [{ ...cands[0], confidence: 0.8 }], tokens: 3 }));
    const deps = baseDeps({}, { pubmed: pubmedSource({ search: jest.fn().mockResolvedValue([pubmedThin('1')]) }) }, { extract, judge });
    const { candidates } = await new ResearchAgent(deps, { ...bounds, maxDraftsPerTopic: 10 }).run('topic');
    expect(judge).toHaveBeenCalledWith(expect.any(Function), [candidate('a'), candidate('b')], 'rct'); // tier from the hydrated RCT paper
    expect(candidates).toHaveLength(1);
    expect(candidates[0].confidence).toBe(0.8);
  });

  it('fans a peer-reviewed paper across all five lenses', async () => {
    const extract = jest.fn().mockResolvedValue({ candidates: [], tokens: 1 });
    const deps = baseDeps({}, { pubmed: pubmedSource({ search: jest.fn().mockResolvedValue([pubmedThin('1')]) }) }, { extract });
    await new ResearchAgent(deps, bounds).run('topic');
    expect(extract.mock.calls[0][3]).toEqual(['behavioral', 'cognitive', 'social', 'environmental', 'physiological']);
  });

  it('collapses to a single lens under token-budget pressure (lenses fall before papers)', async () => {
    const extract = jest.fn().mockResolvedValue({ candidates: [], tokens: 0 });
    // gate pre-spends 85 of a 100 budget, so <20% remains when the paper reaches extract.
    const deps = baseDeps({}, { pubmed: pubmedSource({ search: jest.fn().mockResolvedValue([pubmedThin('1')]) }) },
      { extract, gate: jest.fn().mockResolvedValue({ keep: true, tokens: 85 }) });
    await new ResearchAgent(deps, { ...bounds, tokenBudget: 100 }).run('topic');
    expect(extract.mock.calls[0][3]).toHaveLength(1);
  });

  it('does not count the search phase against the per-topic deadline (slow search still processes)', async () => {
    // Regression: the deadline used to start at run() entry, so a slow source fetch (the preprint
    // window) exhausted agentTimeoutMs before any paper was gated → `agentTimeout tokens=0` on topic 1.
    // The deadline now starts AFTER search, so a search slower than the budget still leaves a full
    // processing budget. Search here (~150ms) exceeds agentTimeoutMs (50ms); the paper must still collect.
    const slowPubmed = pubmedSource({
      search: jest.fn(async () => { await new Promise((r) => setTimeout(r, 150)); return [pubmedThin('1')]; }),
    });
    const deps = baseDeps({}, { pubmed: slowPubmed });
    const agent = new ResearchAgent(deps, { ...bounds, agentTimeoutMs: 50, maxDraftsPerTopic: 10 });
    const { summary } = await agent.run('topic');
    expect(summary.stopReason).not.toBe('agentTimeout');
    expect(summary.collected).toBeGreaterThan(0);
  });

  it('processes a paper returned by two sources only once (cross-source dedup)', async () => {
    // Same sourceId surfaced by two sources → the in-run visited set dedups before any hydrate/extract.
    const shared = pubmedThin('1');
    const extract = jest.fn().mockImplementation((_gen, p: Paper) => Promise.resolve({ candidates: [candidate(p.sourceId.replace('PMID:', ''))], tokens: 10 }));
    const deps = baseDeps({}, {
      pubmed: pubmedSource({ search: jest.fn().mockResolvedValue([shared]) }),
      europepmc: preprintSource('europepmc', { search: jest.fn().mockResolvedValue([{ ...shared }]) }),
    }, { extract });
    const { summary } = await new ResearchAgent(deps, { ...bounds, maxDraftsPerTopic: 10 }).run('topic');
    expect(extract).toHaveBeenCalledTimes(1);
    expect(summary.collected).toBe(1);
  });

  it('judges preprint-sourced papers at the preprint tier', async () => {
    const judge = jest.fn().mockImplementation((_gen: unknown, c: Candidate[]) => Promise.resolve({ candidates: c, tokens: 0 }));
    const deps = baseDeps({}, {
      pubmed: pubmedSource({ search: jest.fn().mockResolvedValue([]) }),
      psyarxiv: preprintSource('psyarxiv', { search: jest.fn().mockResolvedValue([psyPaper('zzz')]) }),
    }, { judge });
    await new ResearchAgent(deps, bounds).run('topic');
    expect(judge).toHaveBeenCalledWith(expect.any(Function), expect.anything(), 'preprint'); // isPreprint → evidenceTier 'preprint'
  });

  it('interleaves sources round-robin so the per-topic cap is shared, not consumed by PubMed first', async () => {
    // pubmed → [1,2,3], psyarxiv → [a,b]. Round-robin queue = PMID:1, osf:a, PMID:2, osf:b, PMID:3.
    // With maxPapersPerTopic=3 the cap stops after 3 — and crucially one of them is a preprint, which
    // the old concat order (all 3 pubmed first) could never reach.
    const deps = baseDeps({}, {
      psyarxiv: preprintSource('psyarxiv', { search: jest.fn().mockResolvedValue([psyPaper('a'), psyPaper('b')]) }),
    });
    const agent = new ResearchAgent(deps, { ...bounds, maxPapersPerTopic: 3, maxDraftsPerTopic: 10 });
    await agent.run('topic');
    // seen() is batched up front but CAPPED at maxPapersPerTopic (3), so it fans out over only the first
    // 3 of the round-robin queue — never the wasted tail (osf:b, PMID:3) the loop's cap stops it reaching.
    // The interleave still proves the cap is SHARED: osf:a precedes PMID:2, so the preprint reaches the
    // gate within the cap instead of being starved behind all of PubMed's block.
    const order = (deps.seen as jest.Mock).mock.calls.map((c) => c[0]);
    expect(order).toEqual(['PMID:1', 'osf:a', 'PMID:2']);
    // PROCESSING is still capped at 3: only the first 3 round-robin papers reach the gate before
    // maxPapersPerTopic stops the run — and one of them (osf:a) is the preprint the old concat order missed.
    expect(deps.pipeline.gate).toHaveBeenCalledTimes(3);
  });

  it('continues when one paper errors (fail-open-empty)', async () => {
    const deps = baseDeps({}, {}, {
      extract: jest.fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockImplementation((_gen, p: Paper) => Promise.resolve({ candidates: [candidate(p.sourceId.replace('PMID:', ''))], tokens: 10 })),
    });
    const agent = new ResearchAgent(deps, bounds);
    const { summary } = await agent.run('topic');
    expect(summary.errors).toBe(1);
    expect(summary.collected).toBeGreaterThanOrEqual(1);
  });
});
