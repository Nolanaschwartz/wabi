/**
 * ResearchAgent ↔ tracing wiring. The orchestrator builds ONE `gen` seam per run from the run's tracer
 * + run-id and passes it into each step; the step's span is emitted INSIDE `gen` on a successful call
 * (the orchestrator no longer re-emits a per-step trace). Tracing is additive — a run completes
 * identically whether the tracer is absent, disabled, or THROWS (it must never break a run, ADR-0021).
 *
 * The steps are faked here, so to prove the wiring the fakes CALL the `gen` they were handed (with their
 * own span name) — that is exactly what the real steps do, and it routes through to the injected tracer.
 */
import { ResearchAgent, AgentDeps, ExtractionPipeline } from '../research-agent';
import { Source } from '../../sources/source';
import { Bounds, Candidate, Paper, SourceKind } from '../../types';
import type { ResearchGenerate } from '../research-generate';

jest.mock('@wabi/shared/generate', () => ({ generate: jest.fn().mockResolvedValue({ text: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: 'm', latencyMs: 3 }) }));

const bounds: Bounds = {
  maxTopicsPerRun: 5, maxPapersPerTopic: 3, searchLimit: 40, maxDiscoverySteps: 1, maxDraftsPerTopic: 2,
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

// Pipeline-step fakes that each drive the handed `gen` with their own span name, mirroring the real steps —
// so a span flows through to the injected tracer exactly when the orchestrator wired `gen` correctly. The
// five are grouped behind the single `pipeline` collaborator (issue 02); a test overrides one method via `pipe`.
function fakePipeline(over: Partial<ExtractionPipeline> = {}): ExtractionPipeline {
  return {
    gate: jest.fn(async (gen: ResearchGenerate, abstract: string) => { await gen('gate', 'research-triage', { prompt: abstract, temperature: 0 }); return { keep: true, tokens: 1 }; }),
    extract: jest.fn(async (gen: ResearchGenerate, p: Paper, body: string) => { await gen('extract', 'research', { prompt: body }); return { candidates: [candidate(p.sourceId.replace('PMID:', ''))], tokens: 10 }; }),
    merge: jest.fn(async (_gen: ResearchGenerate, cands: Candidate[]) => ({ candidates: cands, tokens: 0 })),
    judge: jest.fn(async (_gen: ResearchGenerate, cands: Candidate[]) => ({ candidates: cands, tokens: 0 })),
    dedup: jest.fn(async (gen: ResearchGenerate, c: Candidate) => { await gen('dedup', 'research-triage', { prompt: c.title }); return { duplicate: false, tokens: 0 }; }),
    ...over,
  };
}

function baseDeps(over: Partial<Omit<AgentDeps, 'pipeline'>> = {}, pipe: Partial<ExtractionPipeline> = {}): AgentDeps {
  const sources = new Map<SourceKind, Source>([
    ['pubmed', pubmedSource()],
    ['medrxiv', preprintSource('medrxiv')],
    ['psyarxiv', preprintSource('psyarxiv')],
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

  it('passes the prompt + model/usage/latency through to the gate span', async () => {
    const tracer = fakeTracer();
    const agent = new ResearchAgent(baseDeps(), bounds, undefined, { tracer, runId: 'r' });
    await agent.run('topic');
    const gateSpan = tracer.span.mock.calls.map((c) => c[0]).find((s) => s.span === 'gate');
    // gen prompts with the abstract (A1) and surfaces the generate result's model + usage.
    expect(gateSpan).toMatchObject({ span: 'gate', input: 'A1', output: 'ok', model: 'm', latencyMs: 3 });
    expect(gateSpan.usage).toMatchObject({ inputTokens: 1, outputTokens: 1 });
  });

  it('emits a gate span but NO extract span for a gated-out paper', async () => {
    const tracer = fakeTracer();
    const deps = baseDeps({}, { gate: jest.fn(async (gen: ResearchGenerate, abstract: string) => { await gen('gate', 'research-triage', { prompt: abstract, temperature: 0 }); return { keep: false, tokens: 1 }; }) });
    const agent = new ResearchAgent(deps, bounds, undefined, { tracer, runId: 'r' });
    await agent.run('topic');
    const names = tracer.span.mock.calls.map((c) => c[0].span);
    expect(names).toContain('gate');
    expect(names).not.toContain('extract');
  });

  it('does not emit a dedup span when extract produced no candidate', async () => {
    const tracer = fakeTracer();
    const deps = baseDeps({}, { extract: jest.fn(async (gen: ResearchGenerate, _p: Paper, body: string) => { await gen('extract', 'research', { prompt: body }); return { candidates: [], tokens: 3 }; }) });
    const agent = new ResearchAgent(deps, bounds, undefined, { tracer, runId: 'r' });
    await agent.run('topic');
    const names = tracer.span.mock.calls.map((c) => c[0].span);
    expect(names).toContain('extract');
    expect(names).not.toContain('dedup');
  });

  it('emits no span for a step that short-circuits without calling gen (e.g. dedup prefilter)', async () => {
    const tracer = fakeTracer();
    // dedup short-circuits (kept empty / prefilter) → never calls gen → no dedup span.
    const deps = baseDeps({}, { dedup: jest.fn(async () => ({ duplicate: false, tokens: 0 })) });
    const agent = new ResearchAgent(deps, bounds, undefined, { tracer, runId: 'r' });
    await agent.run('topic');
    const names = tracer.span.mock.calls.map((c) => c[0].span);
    expect(names).not.toContain('dedup');
    expect(names).toContain('gate'); // gate/extract still emit (they call gen)
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
