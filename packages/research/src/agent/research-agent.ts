import { Bounds, Candidate, EvidenceTier, Lens, Paper, RunSummary, SourceKind } from '../types';
import { Source } from '../sources/source';
import { Logger, noopLogger } from '../util/logger';
import { ResearchSpanInput, RunTraceInput } from './research-tracer';
import { makeResearchGenerate, type ResearchGenerate } from './research-generate';
import { evidenceTier } from './extract';
import { prescreen } from './scope-policy';
import { lensesForTier } from './lenses';
import { Concepts } from '../sources/query/concepts';
import { queryForKind } from '../sources/query/for-kind';

// Below this fraction of the token budget remaining, fan a paper out across a SINGLE lens instead of
// the full set — lenses fall before papers, so a near-exhausted run still mines something per paper.
const BUDGET_PRESSURE_FRACTION = 0.2;

export interface AgentDeps {
  /** Evidence sources keyed by kind. Insertion order is the search/queue order (pubmed→medrxiv→psyarxiv).
   * The agent dispatches hydrate/fullText/expand to `sources.get(paper.sourceKind)` (ADR-0036). */
  sources: Map<SourceKind, Source>;
  /** Translate the topic into the literature's vocabulary ONCE per topic (one LLM call); each source
   * renders the result into its own query syntax via {@link queryForKind}. Fail-open inside the builder. */
  buildConcepts: (topic: string) => Promise<Concepts>;
  seen: (sourceId: string) => Promise<boolean>;
  /** Negative-cache a gate rejection so seen() skips this paper next run (never re-gated). */
  markGated: (sourceId: string, source: string) => Promise<void>;
  /** The extraction pipeline the orchestrator collaborates with — the five LLM steps grouped behind one
   * injected collaborator (issue 02). Each method takes the per-run `gen` seam (which binds
   * role+cap+temperature and emits its span) and returns ONLY its domain result; the orchestrator no
   * longer threads or re-emits a StepTrace. Stubbing this one object isolates the orchestration test from
   * real parse logic, which each step's own unit test still exercises through a fake `gen`. */
  pipeline: ExtractionPipeline;
}

/** The five LLM steps the orchestrator runs per paper, grouped behind one seam (issue 02). */
export interface ExtractionPipeline {
  gate(gen: ResearchGenerate, abstract: string, topic: string): Promise<{ keep: boolean; tokens: number }>;
  /** Fan one paper out across the given lenses; returns 0..N candidates (slice 03). */
  extract(gen: ResearchGenerate, paper: Paper, body: string, lenses: Lens[]): Promise<{ candidates: Candidate[]; tokens: number }>;
  /** Collapse a paper's lens candidates into its distinct techniques (slice 04). */
  merge(gen: ResearchGenerate, candidates: Candidate[]): Promise<{ candidates: Candidate[]; tokens: number }>;
  /** Score, faithfulness-check, sharpen, and tier-cap a paper's candidates (slice 05). */
  judge(gen: ResearchGenerate, candidates: Candidate[], tier: EvidenceTier): Promise<{ candidates: Candidate[]; tokens: number }>;
  dedup(gen: ResearchGenerate, candidate: Candidate, kept: Candidate[]): Promise<{ duplicate: boolean; tokens: number }>;
}

/** The structural slice of {@link ResearchTracer} the orchestrator uses. Kept as an interface (not the
 * class) so the agent stays plain TS and a test can hand it a fake. */
export interface AgentTracer {
  run(input: RunTraceInput): void;
  span(input: ResearchSpanInput): void;
}

/** Optional tracing wiring. The orchestrator owns the span tree; the tracer owns the transport. Absent
 * → no tracing at all (the agent's pre-tracing behaviour). */
export interface AgentTracing {
  tracer: AgentTracer;
  /** The trace id for the whole run — every span hangs under this parent. */
  runId: string;
}

function emptySummary(): RunSummary {
  return { searched: 0, seenSkipped: 0, gatedOut: 0, extracted: 0, inRunDeduped: 0,
    collected: 0, submitted: 0, libDeduped: 0, errors: 0, stopReason: 'exhausted' };
}

export class ResearchAgent {
  public tokens = 0;
  constructor(
    private readonly deps: AgentDeps,
    private readonly bounds: Bounds,
    private readonly log: Logger = noopLogger,
    private readonly tracing?: AgentTracing,
  ) {}

  async run(topic: string): Promise<{ candidates: Candidate[]; summary: RunSummary }> {
    const summary = emptySummary();
    const kept: Candidate[] = [];
    const visited = new Set<string>();

    // Build the run's `gen` seam ONCE from the run's tracer + run-id (absent → no spans, generate still
    // runs). Each step calls it instead of importing `generate`; the span for a successful call is
    // emitted inside `gen`, so the orchestrator no longer threads or re-emits per-step traces.
    const gen = makeResearchGenerate(this.tracing?.tracer, this.tracing?.runId);

    this.log.info('topic start', { topic });

    // Upsert the run's parent trace so a paper-less run still appears. Guarded — a tracer error here
    // must never abort the run (ADR-0021).
    if (this.tracing) {
      try {
        this.tracing.tracer.run({ runId: this.tracing.runId, metadata: { topic } });
      } catch (err) {
        this.log.debug('tracer run failed', { err: (err as Error)?.message ?? String(err) });
      }
    }

    // Fan search out across every source (parallel within a source's own rate limiter). Fail-soft: a
    // source that throws logs `<kind> search failed` and contributes nothing — the run never aborts on
    // one bad source. Each source yields whole Papers (thin for pubmed; the agent hydrates later).
    // Translate the topic to the literature's vocabulary once (one LLM call, fail-open), then let each
    // source render it into its own query syntax. Search breadth (searchLimit) is decoupled from the
    // processing cap (maxPapersPerTopic) — fetch a wide, server-ranked pool; the gate + cap pick from it.
    const concepts = await this.deps.buildConcepts(topic);
    const perKind: Partial<Record<SourceKind, number>> = {};
    const bySrc: Paper[][] = [];
    for (const src of this.deps.sources.values()) {
      const query = queryForKind(src.kind, topic, concepts);
      const papers = await src.search(query, this.bounds.searchLimit)
        .catch((e) => { this.log.info(`${src.kind} search failed`, { topic, err: (e as Error)?.message ?? String(e) }); return [] as Paper[]; });
      perKind[src.kind] = papers.length;
      bySrc.push(papers);
    }
    // Interleave round-robin so the per-topic cap (maxPapersPerTopic) is SHARED across sources rather
    // than consumed by the first (PubMed) block — otherwise EPMC/OSF preprints never reach the gate,
    // which is the whole point of the topical-search migration (ADR-0039). Each source keeps its own
    // server-relevance order; we just take one from each in turn.
    const queue: Paper[] = [];
    for (let i = 0; bySrc.some((p) => i < p.length); i++) {
      for (const p of bySrc) if (i < p.length) queue.push(p[i]);
    }
    summary.searched = queue.length;
    this.log.info('search done', { topic, ...perKind, queued: queue.length });

    let papersRead = 0;
    let discoverySteps = 0;

    // The per-topic deadline bounds LLM PROCESSING only — start it after the (bounded) search phase so a
    // slow source fetch can't consume the budget before the first paper is gated. The run as a whole is
    // still capped by runTimeoutMs. (Was set at run() entry, which let topic 1's preprint window fetch
    // exhaust agentTimeoutMs → `agentTimeout tokens=0` before any LLM call. See .scratch/research-search-recall/00.)
    const deadline = Date.now() + this.bounds.agentTimeoutMs;

    // Batch the seen-ledger check for the whole search queue in ONE concurrent fan-out instead of a
    // serial HTTP round-trip per paper inside the loop. In steady state most hits are already seen from
    // prior runs (a seen-skip does no LLM work and never advances papersRead, so the caps don't fire) —
    // that path was up to `searchLimit` sequential round-trips of pure latency. Discovery-expanded papers
    // (pushed mid-loop) aren't here, so the loop keeps a lazy single check for them; a prefetch error
    // leaves the id unresolved → the loop falls back to the original per-paper check (same error path).
    const seenResolved = new Map<string, boolean>();
    await Promise.all(
      queue.map((p) =>
        this.deps.seen(p.sourceId).then((v) => seenResolved.set(p.sourceId, v)).catch(() => {}),
      ),
    );

    while (queue.length > 0) {
      if (kept.length >= this.bounds.maxDraftsPerTopic) { summary.stopReason = 'maxDraftsPerTopic'; break; }
      if (papersRead >= this.bounds.maxPapersPerTopic) { summary.stopReason = 'maxPapersPerTopic'; break; }
      if (Date.now() > deadline) { summary.stopReason = 'agentTimeout'; break; }
      if (this.tokens >= this.bounds.tokenBudget) { summary.stopReason = 'tokenBudget'; break; }

      const item = queue.shift()!;
      if (visited.has(item.sourceId)) continue;
      visited.add(item.sourceId);

      try {
        // Prefetched above for the initial queue; a discovery-expanded id misses the map → lazy check.
        const already = seenResolved.has(item.sourceId)
          ? seenResolved.get(item.sourceId)!
          : await this.deps.seen(item.sourceId);
        if (already) {
          summary.seenSkipped++;
          this.log.debug('skip: already seen', { id: item.sourceId });
          continue;
        }

        const src = this.deps.sources.get(item.sourceKind);
        if (!src) throw new Error(`no source registered for kind ${item.sourceKind}`);

        // Hydrate AFTER the seen-check: identity for preprints, summary+abstract for the thin pubmed
        // hit — so an already-seen pubmed paper never spends a rate-limited fetch (ADR-0036).
        const paper = await src.hydrate(item);
        this.log.info('paper', { id: paper.sourceId, kind: paper.sourceKind, title: paper.title });

        // Deterministic scope pre-screen before any model call: a clear supplement/drug/clinical
        // abstract is dropped here without a gate generation (scope-policy module, ADR-0001/0003).
        // NOT negative-cached: prescreen is a blunt keyword heuristic and fail-open mining (ADR-0021)
        // forbids a deterministic false-positive permanently blacklisting an in-scope paper. The gate
        // LLM is the real arbiter, so a re-fetch next run can still reach it if the policy improves.
        // ponytail: re-screening the same paper each run is the accepted cost of keeping the drop reversible.
        if (!prescreen(paper.abstract)) {
          summary.gatedOut++; papersRead++;
          this.log.info('prescreened out', { id: paper.sourceId }); // distinct from the gate-LLM 'gated out'
          continue;
        }

        const gate = await this.deps.pipeline.gate(gen, paper.abstract, topic);
        this.tokens += gate.tokens;
        this.log.debug('gate', { id: paper.sourceId, keep: gate.keep, tokens: gate.tokens });
        if (!gate.keep) {
          summary.gatedOut++; papersRead++;
          await this.deps.markGated(paper.sourceId, paper.sourceKind); // negative-cache: don't re-gate next run
          this.log.info('gated out', { id: paper.sourceId });
          continue;
        }

        // Citation-graph discovery, where the source offers it (pubmed). Expanded papers re-enter the
        // queue as thin hits and flow through the same hydrate path.
        if (src.expand && discoverySteps < this.bounds.maxDiscoverySteps) {
          discoverySteps++;
          const related = await src.expand(paper).catch(() => [] as Paper[]);
          for (const rp of related) {
            if (!visited.has(rp.sourceId)) queue.push(rp);
          }
          this.log.debug('discovery expand', { from: paper.sourceId, related: related.length, queue: queue.length });
        }

        const full = await src.fullText(paper).catch(() => null);
        const body = full ?? paper.abstract;
        papersRead++;
        this.log.debug('body', { id: paper.sourceId, source: full ? 'fullText' : 'abstract', chars: body.length });

        // Tier-scaled lens fan-out; under budget pressure collapse to one lens (lenses fall before papers).
        const tier = evidenceTier(paper);
        let lenses = lensesForTier(tier);
        if (this.bounds.tokenBudget - this.tokens < this.bounds.tokenBudget * BUDGET_PRESSURE_FRACTION) {
          lenses = lenses.slice(0, 1);
        }

        const { candidates, tokens } = await this.deps.pipeline.extract(gen, paper, body, lenses);
        this.tokens += tokens;
        if (candidates.length === 0) { this.log.info('extract: no candidate', { id: paper.sourceId, tokens }); continue; }

        // Collapse the lens candidates into the paper's distinct techniques, then score + tier-cap them.
        const m = await this.deps.pipeline.merge(gen, candidates);
        this.tokens += m.tokens;

        const j = await this.deps.pipeline.judge(gen, m.candidates, tier);
        this.tokens += j.tokens;
        const distinct = j.candidates;
        summary.extracted += distinct.length;
        this.log.info('extracted', { id: paper.sourceId, candidates: distinct.length, tokens });

        // Each candidate dedups against the run's kept set independently; the topic cap stops mid-paper.
        for (const candidate of distinct) {
          if (kept.length >= this.bounds.maxDraftsPerTopic) { summary.stopReason = 'maxDraftsPerTopic'; break; }
          const dd = await this.deps.pipeline.dedup(gen, candidate, kept);
          this.tokens += dd.tokens;
          if (dd.duplicate) {
            summary.inRunDeduped++;
            this.log.info('in-run duplicate', { id: paper.sourceId, title: candidate.title });
            continue;
          }
          kept.push(candidate);
          summary.collected++;
          this.log.info('collected', { id: paper.sourceId, title: candidate.title, kept: kept.length });
        }
      } catch (err) {
        summary.errors++;
        this.log.info('error processing item', { id: item.sourceId, err: (err as Error)?.message ?? String(err) });
        continue;
      }
    }

    this.log.info('topic done', { topic, ...summary, tokens: this.tokens });
    return { candidates: kept, summary };
  }
}
