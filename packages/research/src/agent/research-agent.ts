import { Bounds, Candidate, EvidenceTier, Lens, Paper, RunSummary, SourceKind } from '../types';
import { Source } from '../sources/source';
import { Logger, noopLogger } from '../util/logger';
import { ResearchSpanName, ResearchSpanInput, RunTraceInput } from './research-tracer';
import { StepTrace } from './relevance-gate';
import { evidenceTier } from './extract';
import { lensesForTier } from './lenses';

// Below this fraction of the token budget remaining, fan a paper out across a SINGLE lens instead of
// the full set — lenses fall before papers, so a near-exhausted run still mines something per paper.
const BUDGET_PRESSURE_FRACTION = 0.2;

export interface AgentDeps {
  /** Evidence sources keyed by kind. Insertion order is the search/queue order (pubmed→medrxiv→psyarxiv).
   * The agent dispatches hydrate/fullText/expand to `sources.get(paper.sourceKind)` (ADR-0036). */
  sources: Map<SourceKind, Source>;
  seen: (sourceId: string) => Promise<boolean>;
  gate: (abstract: string) => Promise<{ keep: boolean; tokens: number; trace?: StepTrace }>;
  /** Fan one paper out across the given lenses; returns 0..N candidates (slice 03). */
  extract: (paper: Paper, body: string, lenses: Lens[]) => Promise<{ candidates: Candidate[]; tokens: number; traces: StepTrace[] }>;
  /** Collapse a paper's lens candidates into its distinct techniques (slice 04). */
  merge: (candidates: Candidate[]) => Promise<{ candidates: Candidate[]; tokens: number; traces: StepTrace[] }>;
  /** Score, faithfulness-check, sharpen, and tier-cap a paper's candidates (slice 05). */
  judge: (candidates: Candidate[], tier: EvidenceTier) => Promise<{ candidates: Candidate[]; tokens: number; traces: StepTrace[] }>;
  dedup: (candidate: Candidate, kept: Candidate[]) => Promise<{ duplicate: boolean; tokens: number; trace?: StepTrace }>;
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

  /** Emit one Langfuse span for a completed step, carrying its leaf data. Inert when no tracer is wired
   * or the step produced no trace (a short-circuited dedup, a fail-open gate error). NEVER throws —
   * tracing is additive and must never break a run (ADR-0021); a tracer error is swallowed + logged. */
  private emitSpan(span: ResearchSpanName, trace: StepTrace | undefined): void {
    if (!this.tracing || !trace) return;
    try {
      this.tracing.tracer.span({
        runId: this.tracing.runId,
        span,
        input: trace.input,
        output: trace.output,
        model: trace.model,
        latencyMs: trace.latencyMs,
        usage: trace.usage,
      });
    } catch (err) {
      this.log.debug('tracer span failed', { span, err: (err as Error)?.message ?? String(err) });
    }
  }

  async run(topic: string): Promise<{ candidates: Candidate[]; summary: RunSummary }> {
    const summary = emptySummary();
    const kept: Candidate[] = [];
    const visited = new Set<string>();
    const deadline = Date.now() + this.bounds.agentTimeoutMs;

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
    const queue: Paper[] = [];
    const perKind: Partial<Record<SourceKind, number>> = {};
    for (const src of this.deps.sources.values()) {
      const papers = await src.search(topic, this.bounds.maxPapersPerTopic)
        .catch((e) => { this.log.info(`${src.kind} search failed`, { topic, err: (e as Error)?.message ?? String(e) }); return [] as Paper[]; });
      perKind[src.kind] = papers.length;
      queue.push(...papers);
    }
    summary.searched = queue.length;
    this.log.info('search done', { topic, ...perKind, queued: queue.length });

    let papersRead = 0;
    let discoverySteps = 0;

    while (queue.length > 0) {
      if (kept.length >= this.bounds.maxDraftsPerTopic) { summary.stopReason = 'maxDraftsPerTopic'; break; }
      if (papersRead >= this.bounds.maxPapersPerTopic) { summary.stopReason = 'maxPapersPerTopic'; break; }
      if (Date.now() > deadline) { summary.stopReason = 'agentTimeout'; break; }
      if (this.tokens >= this.bounds.tokenBudget) { summary.stopReason = 'tokenBudget'; break; }

      const item = queue.shift()!;
      if (visited.has(item.sourceId)) continue;
      visited.add(item.sourceId);

      try {
        if (await this.deps.seen(item.sourceId)) {
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

        const gate = await this.deps.gate(paper.abstract);
        this.tokens += gate.tokens;
        this.emitSpan('gate', gate.trace);
        this.log.debug('gate', { id: paper.sourceId, keep: gate.keep, tokens: gate.tokens });
        if (!gate.keep) { summary.gatedOut++; papersRead++; this.log.info('gated out', { id: paper.sourceId }); continue; }

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

        const { candidates, tokens, traces } = await this.deps.extract(paper, body, lenses);
        this.tokens += tokens;
        for (const t of traces) this.emitSpan('extract', t);
        if (candidates.length === 0) { this.log.info('extract: no candidate', { id: paper.sourceId, tokens }); continue; }

        // Collapse the lens candidates into the paper's distinct techniques, then score + tier-cap them.
        const m = await this.deps.merge(candidates);
        this.tokens += m.tokens;
        for (const t of m.traces) this.emitSpan('merge', t);

        const j = await this.deps.judge(m.candidates, tier);
        this.tokens += j.tokens;
        for (const t of j.traces) this.emitSpan('judge', t);
        const distinct = j.candidates;
        summary.extracted += distinct.length;
        this.log.info('extracted', { id: paper.sourceId, candidates: distinct.length, tokens });

        // Each candidate dedups against the run's kept set independently; the topic cap stops mid-paper.
        for (const candidate of distinct) {
          if (kept.length >= this.bounds.maxDraftsPerTopic) { summary.stopReason = 'maxDraftsPerTopic'; break; }
          const dd = await this.deps.dedup(candidate, kept);
          this.tokens += dd.tokens;
          this.emitSpan('dedup', dd.trace);
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
