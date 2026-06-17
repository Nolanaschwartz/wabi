import { Bounds, Candidate, Paper, RunSummary, SourceKind } from '../types';
import { Source } from '../sources/source';
import { Logger, noopLogger } from '../util/logger';

export interface AgentDeps {
  /** Evidence sources keyed by kind. Insertion order is the search/queue order (pubmed→medrxiv→psyarxiv).
   * The agent dispatches hydrate/fullText/expand to `sources.get(paper.sourceKind)` (ADR-0036). */
  sources: Map<SourceKind, Source>;
  seen: (sourceId: string) => Promise<boolean>;
  gate: (abstract: string) => Promise<{ keep: boolean; tokens: number }>;
  extract: (paper: Paper, body: string) => Promise<{ candidate: Candidate | null; tokens: number }>;
  dedup: (candidate: Candidate, kept: Candidate[]) => Promise<{ duplicate: boolean; tokens: number }>;
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
  ) {}

  async run(topic: string): Promise<{ candidates: Candidate[]; summary: RunSummary }> {
    const summary = emptySummary();
    const kept: Candidate[] = [];
    const visited = new Set<string>();
    const deadline = Date.now() + this.bounds.agentTimeoutMs;

    this.log.info('topic start', { topic });

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

        const { candidate, tokens } = await this.deps.extract(paper, body);
        this.tokens += tokens;
        if (!candidate) { this.log.info('extract: no candidate', { id: paper.sourceId, tokens }); continue; }
        summary.extracted++;
        this.log.info('extracted', { id: paper.sourceId, title: candidate.title, tokens });

        const dd = await this.deps.dedup(candidate, kept);
        this.tokens += dd.tokens;
        if (dd.duplicate) {
          summary.inRunDeduped++;
          this.log.info('in-run duplicate', { id: paper.sourceId, title: candidate.title });
          continue;
        }

        kept.push(candidate);
        summary.collected++;
        this.log.info('collected', { id: paper.sourceId, title: candidate.title, kept: kept.length });
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
