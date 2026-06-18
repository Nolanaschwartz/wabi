/**
 * ResearchAgent ↔ ResearchTracer wiring. The orchestrator owns the span tree: per paper it emits
 * `gate`, then (if kept) `extract`, then (if a candidate) `dedup` spans, using the leaf data the
 * migrated callers now surface. Tracing is additive — a run completes identically whether the tracer
 * is absent, disabled, or THROWS (it must never break a run).
 */
import { ResearchAgent, AgentDeps } from '../research-agent';
import { Source } from '../../sources/source';
import { Bounds, Candidate, Paper, SourceKind } from '../../types';

const bounds: Bounds = {
  maxTopicsPerRun: 5, maxPapersPerTopic: 3, maxDiscoverySteps: 1, maxDraftsPerTopic: 2,
  maxDraftsPerRun: 10, agentTimeoutMs: 5000, runTimeoutMs: 60000, tokenBudget: 1_000_000,
};

function pubmedThin(id: string): Paper {
  return { sourceId: `PMID:${id}`, sourceKind: 'pubmed', title: '', abstract: '',
    url: `https://pubmed.ncbi.nlm.nih.gov/${id}`, pubTypes: [], isPreprint: false };
}
function candidate(id: string): Candidate {
  return { title: `Tech ${id}`, technique: `do ${id}`, sourceText: `A${id}`, evidence: 'peer-reviewed: RCT',
    evidenceTier: 'rct', sourceUrl: `u${id}`, source: 'PubMed', sourceId: `PMID:${id}`, sourceKind: 'pubmed', trustLevel: 'research-agent' };
}
function pubmedSource(over: Partial<Source> = {}): Source {
  return {
    kind: 'pubmed',
    search: jest.fn().mockResolvedValue([pubmedThin('1')]),
    hydrate: jest.fn(async (p: Paper) => {
      const id = p.sourceId.replace('PMID:', '');
      return { ...p, title: `T${id}`, abstract: `A${id}`, pubTypes: ['Randomized Controlled Trial'] };
    }),
    fullText: jest.fn().mockResolvedValue(null),
    expand: jest.fn().mockResolvedValue([]),
    ...over,
  } as Source;
}
function preprintSource(kind: SourceKind): Source {
  return { kind, search: jest.fn().mockResolvedValue([]), hydrate: jest.fn(async (p: Paper) => p),
    fullText: jest.fn().mockResolvedValue(null) } as Source;
}

function baseDeps(over: Partial<AgentDeps> = {}): AgentDeps {
  const sources = new Map<SourceKind, Source>([
    ['pubmed', pubmedSource()],
    ['medrxiv', preprintSource('medrxiv')],
    ['psyarxiv', preprintSource('psyarxiv')],
  ]);
  return {
    sources,
    seen: jest.fn().mockResolvedValue(false),
    gate: jest.fn().mockResolvedValue({ keep: true, tokens: 1, trace: { input: 'A1', output: 'yes', model: 'm', latencyMs: 2 } }),
    extract: jest.fn().mockImplementation((p: Paper) => Promise.resolve({
      candidates: [candidate(p.sourceId.replace('PMID:', ''))], tokens: 10,
      traces: [{ input: 'body', output: '{json}', model: 'm', latencyMs: 5 }],
    })),
    merge: jest.fn().mockImplementation((cands: Candidate[]) => Promise.resolve({ candidates: cands, tokens: 0, traces: [] })),
    judge: jest.fn().mockImplementation((cands: Candidate[]) => Promise.resolve({ candidates: cands, tokens: 0, traces: [] })),
    dedup: jest.fn().mockResolvedValue({ duplicate: false, tokens: 0, trace: { input: 'A vs B', output: 'different', model: 'm', latencyMs: 1 } }),
    ...over,
  };
}

function fakeTracer() {
  return { run: jest.fn(), span: jest.fn() };
}

describe('ResearchAgent tracing', () => {
  it('emits a parent run trace + gate/extract/dedup spans for a processed paper', async () => {
    const tracer = fakeTracer();
    const agent = new ResearchAgent(baseDeps(), bounds, undefined, { tracer, runId: 'run-x' });
    await agent.run('topic');

    expect(tracer.run).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-x' }));
    const spanNames = tracer.span.mock.calls.map((c) => c[0].span);
    expect(spanNames).toEqual(expect.arrayContaining(['gate', 'extract', 'dedup']));
    // every span hangs under the same run
    expect(tracer.span.mock.calls.every((c) => c[0].runId === 'run-x')).toBe(true);
  });

  it('passes the leaf data through to the gate span (input/output/model/latency)', async () => {
    const tracer = fakeTracer();
    const agent = new ResearchAgent(baseDeps(), bounds, undefined, { tracer, runId: 'r' });
    await agent.run('topic');
    const gateSpan = tracer.span.mock.calls.map((c) => c[0]).find((s) => s.span === 'gate');
    expect(gateSpan).toMatchObject({ span: 'gate', input: 'A1', output: 'yes', model: 'm', latencyMs: 2 });
  });

  it('emits a gate span but NO extract span for a gated-out paper', async () => {
    const tracer = fakeTracer();
    const deps = baseDeps({ gate: jest.fn().mockResolvedValue({ keep: false, tokens: 1, trace: { input: 'A1', output: 'no' } }) });
    const agent = new ResearchAgent(deps, bounds, undefined, { tracer, runId: 'r' });
    await agent.run('topic');
    const names = tracer.span.mock.calls.map((c) => c[0].span);
    expect(names).toContain('gate');
    expect(names).not.toContain('extract');
  });

  it('does not emit a dedup span when extract produced no candidate', async () => {
    const tracer = fakeTracer();
    const deps = baseDeps({ extract: jest.fn().mockResolvedValue({ candidates: [], tokens: 3, traces: [{ input: 'body', output: 'null' }] }) });
    const agent = new ResearchAgent(deps, bounds, undefined, { tracer, runId: 'r' });
    await agent.run('topic');
    const names = tracer.span.mock.calls.map((c) => c[0].span);
    expect(names).toContain('extract');
    expect(names).not.toContain('dedup');
  });

  it('omits a span when a step returns no trace (e.g. dedup short-circuit) — never a partial span', async () => {
    const tracer = fakeTracer();
    // dedup short-circuits (kept empty / prefilter) → no trace; the orchestrator must not emit a dedup span.
    const deps = baseDeps({ dedup: jest.fn().mockResolvedValue({ duplicate: false, tokens: 0 }) });
    const agent = new ResearchAgent(deps, bounds, undefined, { tracer, runId: 'r' });
    await agent.run('topic');
    const names = tracer.span.mock.calls.map((c) => c[0].span);
    expect(names).not.toContain('dedup');
    expect(names).toContain('gate'); // gate/extract still emit (they carry traces)
  });

  it('completes the run unchanged when NO tracer is wired (tracing absent)', async () => {
    const agent = new ResearchAgent(baseDeps(), bounds); // no opts
    const { candidates, summary } = await agent.run('topic');
    expect(candidates).toHaveLength(1);
    expect(summary.collected).toBe(1);
  });

  it('completes the run even when the tracer THROWS on every call (tracing never breaks a run)', async () => {
    const tracer = {
      run: jest.fn(() => { throw new Error('run boom'); }),
      span: jest.fn(() => { throw new Error('span boom'); }),
    };
    const agent = new ResearchAgent(baseDeps(), bounds, undefined, { tracer, runId: 'r' });
    const { candidates, summary } = await agent.run('topic');
    expect(candidates).toHaveLength(1);
    expect(summary.collected).toBe(1);
  });
});
