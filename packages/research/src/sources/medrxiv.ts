import { RateLimiter } from '../util/rate-limiter';
import { Paper, SourceKind } from '../types';
import { Source } from './source';
import { Logger, noopLogger } from '../util/logger';
import { contentTerms, minMatch, scoreRecord } from './term-match';
import { fetchAndParsePdf } from './pdf';
import { loadSourceConfig } from '../config';

const BASE = 'https://api.medrxiv.org/details/medrxiv';
const PAGE = 100; // medRxiv details endpoint returns 100 records per cursor page.

export interface MedrxivDeps {
  fetchFn?: typeof fetch;
  minIntervalMs?: number;
  windowDays?: number;       // how far back to scan (default 60)
  maxRecords?: number;       // cap on records pulled per window (default 1500, env-tunable)
  minTermFraction?: number;  // fraction of query content-terms a record must contain (default 0.5)
  maxPdfBytes?: number;      // full-text PDF size cap (default 20MB, env-tunable)
  maxTextChars?: number;     // extracted full-text char cap (default 50k, env-tunable)
  parsePdf?: (buf: Uint8Array) => Promise<string>; // injectable for tests; default = unpdf
  now?: () => Date;          // injectable clock for tests
  log?: Logger;
}

interface MedrxivRecord { doi: string; title: string; abstract: string; date: string; version?: string }

export class MedrxivTool implements Source {
  readonly kind: SourceKind = 'medrxiv';
  private readonly fetchFn: typeof fetch;
  private readonly limiter: RateLimiter;
  private readonly windowDays: number;
  private readonly maxRecords: number;
  private readonly minTermFraction: number;
  private readonly maxPdfBytes: number;
  private readonly maxTextChars: number;
  private readonly parsePdf?: (buf: Uint8Array) => Promise<string>;
  private readonly now: () => Date;
  private readonly log: Logger;
  // Cache the fetched window so every topic in a run filters the SAME records without re-paginating.
  private cache: { key: string; records: MedrxivRecord[] } | null = null;

  constructor(deps: MedrxivDeps = {}) {
    // Env-derived defaults come from config.ts (shared RESEARCH_* with RESEARCH_MEDRXIV_* overrides),
    // resolved lazily here (constructed per-run after ConfigModule loads), never frozen at import.
    const cfg = loadSourceConfig('medrxiv');
    this.fetchFn = deps.fetchFn ?? fetch;
    this.limiter = new RateLimiter(deps.minIntervalMs ?? 1000);
    this.windowDays = deps.windowDays ?? cfg.windowDays;
    this.maxRecords = deps.maxRecords ?? cfg.maxRecords;
    this.minTermFraction = deps.minTermFraction ?? cfg.minTermFraction;
    this.maxPdfBytes = deps.maxPdfBytes ?? cfg.maxPdfBytes;
    this.maxTextChars = deps.maxTextChars ?? cfg.maxTextChars;
    this.parsePdf = deps.parsePdf;
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
        if (!r?.doi) continue;
        const existing = byDoi.get(r.doi);
        // medRxiv emits one row per version (ascending); keep the HIGHEST so search() presents — and
        // fullText() fetches — the current version, not a superseded one. New dois count as progress.
        if (!existing) { byDoi.set(r.doi, r); added++; }
        else if (Number(r.version ?? 0) > Number(existing.version ?? 0)) byDoi.set(r.doi, r);
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

  /** Keep preprints that contain ENOUGH of the query's content terms (not all of them), ranked by how
   * many match. Strict all-terms-AND made multi-word gaming topics match ~nothing on a clinical
   * corpus; this trades a little precision for recall, and the downstream relevance gate + human
   * review filter the rest. The API includes the abstract, so no extra fetch is needed. */
  async search(query: string, limit: number): Promise<Paper[]> {
    const to = this.now();
    const from = new Date(to.getTime() - this.windowDays * 86_400_000);
    const records = await this.windowRecords(this.fmt(from), this.fmt(to));

    const terms = contentTerms(query);
    // ≤2 terms: require all (a 1–2 word query is already specific). More: require a fraction, min 2.
    const need = minMatch(terms.length, this.minTermFraction);
    // Whole-word match (not substring): "term" must not count inside "determine", and gibberish must
    // not accidentally match. \W tokenization in contentTerms already split hyphens etc.
    const scored = records
      .map((r) => ({ r, score: scoreRecord(`${r.title} ${r.abstract}`, terms) }))
      .filter((x) => x.score >= need)
      .sort((a, b) => b.score - a.score);

    return scored
      .slice(0, limit)
      .map(({ r }) => ({
        sourceId: `doi:${r.doi}`,
        sourceKind: 'medrxiv' as const,
        title: r.title,
        abstract: r.abstract,
        url: `https://www.medrxiv.org/content/${r.doi}`,
        pubTypes: [],
        isPreprint: true,
      }));
  }

  /** Preprint list endpoints already return complete papers, so hydrate is the identity (ADR-0036). */
  async hydrate(paper: Paper): Promise<Paper> {
    return paper;
  }

  /** Full text from medRxiv's open-access PDF: `<doi>v<version>.full.pdf`. The version comes from the
   * window cache primed by search(); when the doi wasn't in the window (or carried no version) we fall
   * back to `v1`. Fail-safe: any HTTP/oversize/parse failure → null, and the agent reads the abstract. */
  async fullText(paper: Paper): Promise<string | null> {
    const doi = paper.sourceId.replace(/^doi:/, '');
    const version = this.cache?.records.find((r) => r.doi === doi)?.version ?? '1';
    const url = `https://www.medrxiv.org/content/${doi}v${version}.full.pdf`;
    return fetchAndParsePdf(url, {
      fetchFn: this.fetchFn,
      schedule: (fn) => this.limiter.schedule(fn),
      maxPdfBytes: this.maxPdfBytes,
      maxTextChars: this.maxTextChars,
      parsePdf: this.parsePdf,
      log: this.log,
    });
  }
}
