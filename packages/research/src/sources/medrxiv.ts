import { RateLimiter } from '../util/rate-limiter';
import { Paper } from '../types';

const BASE = 'https://api.medrxiv.org/details/medrxiv';

export interface MedrxivDeps {
  fetchFn?: typeof fetch;
  minIntervalMs?: number;
  windowDays?: number;       // how far back to scan (default 60)
  now?: () => Date;          // injectable clock for tests
}

interface MedrxivRecord { doi: string; title: string; abstract: string; date: string }

export class MedrxivTool {
  private readonly fetchFn: typeof fetch;
  private readonly limiter: RateLimiter;
  private readonly windowDays: number;
  private readonly now: () => Date;

  constructor(deps: MedrxivDeps = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.limiter = new RateLimiter(deps.minIntervalMs ?? 1000);
    this.windowDays = deps.windowDays ?? 60;
    this.now = deps.now ?? (() => new Date());
  }

  private fmt(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  /** Fetch a recent window of preprints and keep those whose title/abstract contains every query
   * term (case-insensitive). The API includes the abstract, so no extra fetch is needed. */
  async search(query: string, limit: number): Promise<Paper[]> {
    const to = this.now();
    const from = new Date(to.getTime() - this.windowDays * 86_400_000);
    const url = `${BASE}/${this.fmt(from)}/${this.fmt(to)}/0/json`;
    const data = await this.limiter.schedule(async () => {
      const res = await this.fetchFn(url);
      if (!res.ok) throw new Error(`medRxiv HTTP ${res.status}`);
      return (await res.json()) as { collection?: MedrxivRecord[] };
    });

    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (r: MedrxivRecord) => {
      const hay = `${r.title} ${r.abstract}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    };

    return (data.collection ?? [])
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
