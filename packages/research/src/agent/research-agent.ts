import { Bounds, Candidate, Paper, RunSummary, SourceKind } from '../types';
import { Logger, noopLogger } from '../util/logger';

export interface PubMedLike {
  search(query: string, limit: number): Promise<string[]>;
  summary(pmid: string): Promise<{ title: string; pubTypes: string[] }>;
  abstract(pmid: string): Promise<string>;
  related(pmid: string): Promise<string[]>;
  fullText(pmid: string): Promise<string | null>;
}
export interface MedrxivLike {
  search(query: string, limit: number): Promise<Paper[]>;
  fullText(sourceId: string): Promise<string | null>;
}
export interface AgentDeps {
  pubmed: PubMedLike;
  medrxiv: MedrxivLike;
  psyarxiv: MedrxivLike; // same shape as medRxiv: search(query, limit) + fullText(sourceId)
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
    const pmids = await this.deps.pubmed.search(topic, this.bounds.maxPapersPerTopic)
      .catch((e) => { this.log.info('pubmed search failed', { topic, err: (e as Error)?.message ?? String(e) }); return []; });
    const medPapers = await this.deps.medrxiv.search(topic, this.bounds.maxPapersPerTopic)
      .catch((e) => { this.log.info('medrxiv search failed', { topic, err: (e as Error)?.message ?? String(e) }); return []; });
    const psyPapers = await this.deps.psyarxiv.search(topic, this.bounds.maxPapersPerTopic)
      .catch((e) => { this.log.info('psyarxiv search failed', { topic, err: (e as Error)?.message ?? String(e) }); return []; });
    const queue: Array<{ kind: SourceKind; id: string; paper?: Paper }> = [
      // Prefix direct search hits with `PMID:` so their id matches the form used everywhere else —
      // discovery expansion, paper.sourceId, and the bot's ProcessedSource ledger key. A bare PMID
      // here made seen() and `visited` miss, re-submitting the same paper every run (duplicate drafts).
      ...pmids.map((id) => ({ kind: 'pubmed' as const, id: `PMID:${id}` })),
      ...medPapers.map((p) => ({ kind: 'medrxiv' as const, id: p.sourceId, paper: p })),
      ...psyPapers.map((p) => ({ kind: 'psyarxiv' as const, id: p.sourceId, paper: p })),
    ];
    summary.searched = queue.length;
    this.log.info('search done', { topic, pubmed: pmids.length, medrxiv: medPapers.length, psyarxiv: psyPapers.length, queued: queue.length });

    let papersRead = 0;
    let discoverySteps = 0;

    while (queue.length > 0) {
      if (kept.length >= this.bounds.maxDraftsPerTopic) { summary.stopReason = 'maxDraftsPerTopic'; break; }
      if (papersRead >= this.bounds.maxPapersPerTopic) { summary.stopReason = 'maxPapersPerTopic'; break; }
      if (Date.now() > deadline) { summary.stopReason = 'agentTimeout'; break; }
      if (this.tokens >= this.bounds.tokenBudget) { summary.stopReason = 'tokenBudget'; break; }

      const item = queue.shift()!;
      if (visited.has(item.id)) continue;
      visited.add(item.id);

      try {
        if (await this.deps.seen(item.id)) {
          summary.seenSkipped++;
          this.log.debug('skip: already seen', { id: item.id });
          continue;
        }

        let paper: Paper;
        if (item.paper) {
          paper = item.paper;
        } else {
          const pmid = item.id.replace('PMID:', '');
          const [s, abstract] = await Promise.all([
            this.deps.pubmed.summary(pmid),
            this.deps.pubmed.abstract(pmid),
          ]);
          paper = { sourceId: `PMID:${pmid}`, sourceKind: 'pubmed', title: s.title, abstract,
            url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}`, pubTypes: s.pubTypes, isPreprint: false };
        }
        this.log.info('paper', { id: paper.sourceId, kind: paper.sourceKind, title: paper.title });

        const gate = await this.deps.gate(paper.abstract);
        this.tokens += gate.tokens;
        this.log.debug('gate', { id: paper.sourceId, keep: gate.keep, tokens: gate.tokens });
        if (!gate.keep) { summary.gatedOut++; papersRead++; this.log.info('gated out', { id: paper.sourceId }); continue; }

        if (paper.sourceKind === 'pubmed' && discoverySteps < this.bounds.maxDiscoverySteps) {
          discoverySteps++;
          const related = await this.deps.pubmed.related(paper.sourceId.replace('PMID:', '')).catch(() => []);
          for (const rid of related) {
            const sid = `PMID:${rid}`;
            if (!visited.has(sid)) queue.push({ kind: 'pubmed', id: sid });
          }
          this.log.debug('discovery expand', { from: paper.sourceId, related: related.length, queue: queue.length });
        }

        // Route full-text by source kind explicitly: each source owns its own id keyspace and fetcher.
        // A catch-all else-arm would mis-route (e.g. send an osf: id to medrxiv.fullText).
        let full: string | null = null;
        if (paper.sourceKind === 'pubmed') {
          full = await this.deps.pubmed.fullText(paper.sourceId.replace('PMID:', '')).catch(() => null);
        } else if (paper.sourceKind === 'medrxiv') {
          full = await this.deps.medrxiv.fullText(paper.sourceId).catch(() => null);
        } else if (paper.sourceKind === 'psyarxiv') {
          full = await this.deps.psyarxiv.fullText(paper.sourceId).catch(() => null);
        }
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
        this.log.info('error processing item', { id: item.id, err: (err as Error)?.message ?? String(err) });
        continue;
      }
    }

    this.log.info('topic done', { topic, ...summary, tokens: this.tokens });
    return { candidates: kept, summary };
  }
}
