import { Bounds, Candidate, Paper, RunSummary, SourceKind } from '../types';

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
  constructor(private readonly deps: AgentDeps, private readonly bounds: Bounds) {}

  async run(topic: string): Promise<{ candidates: Candidate[]; summary: RunSummary }> {
    const summary = emptySummary();
    const kept: Candidate[] = [];
    const visited = new Set<string>();
    const deadline = Date.now() + this.bounds.agentTimeoutMs;

    const pmids = await this.deps.pubmed.search(topic, this.bounds.maxPapersPerTopic).catch(() => []);
    const medPapers = await this.deps.medrxiv.search(topic, this.bounds.maxPapersPerTopic).catch(() => []);
    const queue: Array<{ kind: SourceKind; id: string; paper?: Paper }> = [
      ...pmids.map((id) => ({ kind: 'pubmed' as const, id })),
      ...medPapers.map((p) => ({ kind: 'medrxiv' as const, id: p.sourceId, paper: p })),
    ];
    summary.searched = queue.length;

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
        if (await this.deps.seen(item.id)) { summary.seenSkipped++; continue; }

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

        const gate = await this.deps.gate(paper.abstract);
        this.tokens += gate.tokens;
        if (!gate.keep) { summary.gatedOut++; papersRead++; continue; }

        if (paper.sourceKind === 'pubmed' && discoverySteps < this.bounds.maxDiscoverySteps) {
          discoverySteps++;
          const related = await this.deps.pubmed.related(paper.sourceId.replace('PMID:', '')).catch(() => []);
          for (const rid of related) {
            const sid = `PMID:${rid}`;
            if (!visited.has(sid)) queue.push({ kind: 'pubmed', id: sid });
          }
        }

        const full = paper.sourceKind === 'pubmed'
          ? await this.deps.pubmed.fullText(paper.sourceId.replace('PMID:', '')).catch(() => null)
          : await this.deps.medrxiv.fullText(paper.sourceId).catch(() => null);
        const body = full ?? paper.abstract;
        papersRead++;

        const { candidate, tokens } = await this.deps.extract(paper, body);
        this.tokens += tokens;
        if (!candidate) continue;
        summary.extracted++;

        const dd = await this.deps.dedup(candidate, kept);
        this.tokens += dd.tokens;
        if (dd.duplicate) { summary.inRunDeduped++; continue; }

        kept.push(candidate);
        summary.collected++;
      } catch {
        summary.errors++;
        continue;
      }
    }

    return { candidates: kept, summary };
  }
}
