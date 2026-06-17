import { RateLimiter } from '../util/rate-limiter';
import { Paper } from '../types';
import { Logger, noopLogger } from '../util/logger';

const BASE = 'https://api.medrxiv.org/details/medrxiv';
const PAGE = 100; // medRxiv details endpoint returns 100 records per cursor page.

export interface MedrxivDeps {
  fetchFn?: typeof fetch;
  minIntervalMs?: number;
  windowDays?: number;       // how far back to scan (default 60)
  maxRecords?: number;       // cap on records pulled per window (default 1500, env-tunable)
  now?: () => Date;          // injectable clock for tests
  log?: Logger;
}

interface MedrxivRecord { doi: string; title: string; abstract: string; date: string }

export class MedrxivTool {
  private readonly fetchFn: typeof fetch;
  private readonly limiter: RateLimiter;
  private readonly windowDays: number;
  private readonly maxRecords: number;
  private readonly now: () => Date;
  private readonly log: Logger;
  // Cache the fetched window so every topic in a run filters the SAME records without re-paginating.
  private cache: { key: string; records: MedrxivRecord[] } | null = null;

  constructor(deps: MedrxivDeps = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.limiter = new RateLimiter(deps.minIntervalMs ?? 1000);
    this.windowDays = deps.windowDays ?? 60;
    this.maxRecords = deps.maxRecords ?? (Number(process.env.RESEARCH_MEDRXIV_MAX_RECORDS) || 1500);
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? noopLogger;
  }

  private fmt(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  /** Page through the whole recent window (the details endpoint returns only 100 records per cursor,
   * out of thousands), deduping by DOI and capping at maxRecords. Cached per window so the cost is
   * paid once per run, not once per topic. */
  private async windowRecords(from: string, to: string): Promise<MedrxivRecord[]> {
    const key = `${from}/${to}`;
    if (this.cache?.key === key) return this.cache.records;

    const byDoi = new Map<string, MedrxivRecord>();
    let total = Infinity;
    let offset = 0;
    const maxPages = Math.ceil(this.maxRecords / PAGE) + 1;

    for (let i = 0; i < maxPages; i++) {
      let recs: MedrxivRecord[];
      let pageTotal: number | undefined;
      try {
        const data = await this.limiter.schedule(async () => {
          const res = await this.fetchFn(`${BASE}/${from}/${to}/${offset}/json`);
          if (!res.ok) throw new Error(`medRxiv HTTP ${res.status}`);
          return (await res.json()) as { collection?: MedrxivRecord[]; messages?: { total?: number }[] };
        });
        recs = data.collection ?? [];
        pageTotal = data.messages?.[0]?.total;
      } catch (e) {
        // Keep whatever we already paged rather than losing the window to one bad page.
        this.log.info('medrxiv page failed', { offset, err: (e as Error)?.message ?? String(e) });
        break;
      }
      if (typeof pageTotal === 'number') total = pageTotal;

      let added = 0;
      for (const r of recs) {
        if (r?.doi && !byDoi.has(r.doi)) { byDoi.set(r.doi, r); added++; }
      }

      if (recs.length < PAGE) break;          // last (or only) page
      if (byDoi.size >= total) break;         // whole window covered
      if (byDoi.size >= this.maxRecords) break; // hit the cap
      if (added === 0) break;                 // no progress (e.g. a mock that ignores the cursor)
      offset += recs.length;
    }

    const records = [...byDoi.values()];
    this.cache = { key, records };
    this.log.info('medrxiv window fetched', {
      window: key, records: records.length,
      total: Number.isFinite(total) ? total : records.length,
      capped: records.length >= this.maxRecords,
    });
    return records;
  }

  /** Keep preprints whose title/abstract contains every query term (case-insensitive). The API
   * includes the abstract, so no extra fetch is needed. */
  async search(query: string, limit: number): Promise<Paper[]> {
    const to = this.now();
    const from = new Date(to.getTime() - this.windowDays * 86_400_000);
    const records = await this.windowRecords(this.fmt(from), this.fmt(to));

    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (r: MedrxivRecord) => {
      const hay = `${r.title} ${r.abstract}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    };

    return records
      .filter(matches)
      .slice(0, limit)
      .map((r) => ({
        sourceId: `doi:${r.doi}`,
        sourceKind: 'medrxiv' as const,
        title: r.title,
        abstract: r.abstract,
        url: `https://www.medrxiv.org/content/${r.doi}`,
        pubTypes: [],
        isPreprint: true,
      }));
  }

  /** v1: medRxiv full-text JATS fetch is deferred; the agent reads the abstract from search(). */
  async fullText(_sourceId: string): Promise<string | null> {
    return null;
  }
}
