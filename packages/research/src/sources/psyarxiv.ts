import { RateLimiter } from '../util/rate-limiter';
import { Paper, SourceKind } from '../types';
import { Source } from './source';
import { Logger, noopLogger } from '../util/logger';
import { contentTerms, minMatch, scoreRecord } from './term-match';
import { fetchAndParsePdf } from './pdf';
import { loadSourceConfig } from '../config';

const BASE = 'https://api.osf.io/v2/preprints/';
const PAGE = 100; // OSF page[size] cap.

export interface PsyArxivDeps {
  fetchFn?: typeof fetch;
  token?: string;            // OSF personal token -> higher rate limit; from OSF_TOKEN
  minIntervalMs?: number;    // default 1000
  windowDays?: number;       // default 60; env RESEARCH_PSYARXIV_WINDOW_DAYS
  maxRecords?: number;       // default 1500; env RESEARCH_PSYARXIV_MAX_RECORDS
  minTermFraction?: number;  // default 0.5; env RESEARCH_PSYARXIV_MIN_TERM_FRACTION
  maxPdfBytes?: number;      // full-text PDF size cap (default 20MB; env RESEARCH_PSYARXIV_MAX_PDF_BYTES)
  maxTextChars?: number;     // extracted full-text char cap (default 50k; env RESEARCH_PSYARXIV_MAX_TEXT_CHARS)
  parsePdf?: (buf: Uint8Array) => Promise<string>; // injectable for tests; default = unpdf
  now?: () => Date;          // injectable clock for tests
  log?: Logger;
}

// OSF API v2 preprint record (only the fields we read). The guid is `id`; topical text lives under
// `attributes`. Verified against a live `?filter[provider]=psyarxiv` response.
interface OsfRecord { id: string; attributes?: { title?: string; description?: string; date_published?: string } }
interface OsfPage { data?: OsfRecord[]; links?: { next?: string | null } }

export class PsyArxivTool implements Source {
  readonly kind: SourceKind = 'psyarxiv';
  private readonly fetchFn: typeof fetch;
  private readonly token?: string;
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
  private cache: { key: string; records: OsfRecord[] } | null = null;

  constructor(deps: PsyArxivDeps = {}) {
    // Env-derived defaults come from config.ts (shared RESEARCH_* with RESEARCH_PSYARXIV_* overrides),
    // resolved lazily here (constructed per-run after ConfigModule loads), never frozen at import.
    const cfg = loadSourceConfig('psyarxiv');
    this.fetchFn = deps.fetchFn ?? fetch;
    this.token = deps.token ?? (process.env.OSF_TOKEN || undefined);
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

  /** Bearer auth when a token is configured; OSF works anonymously otherwise (lower rate limit). */
  private authInit(): RequestInit | undefined {
    return this.token ? { headers: { Authorization: `Bearer ${this.token}` } } : undefined;
  }

  private async getJson<T>(url: string): Promise<T> {
    return this.limiter.schedule(async () => {
      const res = await this.fetchFn(url, this.authInit());
      if (!res.ok) throw new Error(`OSF HTTP ${res.status}`);
      return (await res.json()) as T;
    });
  }

  private firstPageUrl(from: string): string {
    const u = new URL(BASE);
    u.searchParams.set('filter[provider]', 'psyarxiv');
    u.searchParams.set('filter[date_published][gte]', from);
    u.searchParams.set('sort', '-date_published'); // newest first, so the maxRecords cap keeps recent ones
    u.searchParams.set('page[size]', String(PAGE));
    return u.toString();
  }

  /** Page the recent PsyArXiv window following OSF's `links.next`, deduping by guid and capping at
   * maxRecords. Cached per window so the cost is paid once per run, not once per topic. */
  private async windowRecords(from: string): Promise<OsfRecord[]> {
    if (this.cache?.key === from) return this.cache.records;

    const init = this.authInit();
    const byGuid = new Map<string, OsfRecord>();
    let url: string | null = this.firstPageUrl(from);
    const maxPages = Math.ceil(this.maxRecords / PAGE) + 1;

    for (let i = 0; i < maxPages && url; i++) {
      let data: OsfPage;
      try {
        data = await this.limiter.schedule(async () => {
          const res = await this.fetchFn(url as string, init);
          if (!res.ok) throw new Error(`OSF HTTP ${res.status}`);
          return (await res.json()) as OsfPage;
        });
      } catch (e) {
        // Keep whatever we already paged rather than losing the window to one bad page.
        this.log.info('psyarxiv page failed', { url, err: (e as Error)?.message ?? String(e) });
        break;
      }

      for (const r of data.data ?? []) {
        if (r?.id && !byGuid.has(r.id)) byGuid.set(r.id, r);
      }

      if (byGuid.size >= this.maxRecords) break; // hit the cap
      // Termination is driven by OSF's pagination link, not by "no new records this page": with
      // `sort=-date_published`, records sharing a date can straddle a page boundary, so an all-dup
      // page is not end-of-window. `maxPages` is the infinite-loop backstop.
      url = data.links?.next ?? null;
    }

    const records = [...byGuid.values()];
    this.cache = { key: from, records };
    this.log.info('psyarxiv window fetched', { from, records: records.length, capped: records.length >= this.maxRecords });
    return records;
  }

  /** Keep preprints containing ENOUGH of the query's content terms (shared term-match rules with
   * medRxiv), ranked by how many match. The OSF list response includes the abstract
   * (`attributes.description`), so no extra fetch is needed. */
  async search(query: string, limit: number): Promise<Paper[]> {
    const to = this.now();
    const from = new Date(to.getTime() - this.windowDays * 86_400_000);
    const records = await this.windowRecords(this.fmt(from));

    const terms = contentTerms(query);
    const need = minMatch(terms.length, this.minTermFraction);

    const scored = records
      .map((r) => ({ r, score: scoreRecord(`${r.attributes?.title ?? ''} ${r.attributes?.description ?? ''}`, terms) }))
      .filter((x) => x.score >= need)
      .sort((a, b) => b.score - a.score);

    return scored
      .slice(0, limit)
      .map(({ r }) => ({
        sourceId: `osf:${r.id}`,
        sourceKind: 'psyarxiv' as const,
        title: r.attributes?.title ?? '',
        abstract: r.attributes?.description ?? '',
        url: `https://osf.io/${r.id}`,
        pubTypes: [],
        isPreprint: true,
      }));
  }

  /** Preprint list endpoints already return complete papers, so hydrate is the identity (ADR-0036). */
  async hydrate(paper: Paper): Promise<Paper> {
    return paper;
  }

  /** Full text from the preprint's primary PDF: resolve `osf:<guid>` → preprint detail →
   * `primary_file` file node → `links.download`, then download+parse via the shared helper with
   * PsyArXiv's caps. Fail-safe: any HTTP/missing-link/oversize/parse failure → null → abstract. */
  async fullText(paper: Paper): Promise<string | null> {
    try {
      const guid = paper.sourceId.replace(/^osf:/, '');
      const detail = await this.getJson<{
        data?: { relationships?: { primary_file?: { links?: { related?: { href?: string } } } } };
      }>(`${BASE}${guid}/`);
      const fileHref = detail.data?.relationships?.primary_file?.links?.related?.href;
      if (!fileHref) return null;

      const fileNode = await this.getJson<{ data?: { links?: { download?: string } } }>(fileHref);
      const downloadUrl = fileNode.data?.links?.download;
      if (!downloadUrl) return null;

      return await fetchAndParsePdf(downloadUrl, {
        fetchFn: this.fetchFn,
        schedule: (fn) => this.limiter.schedule(fn),
        maxPdfBytes: this.maxPdfBytes,
        maxTextChars: this.maxTextChars,
        parsePdf: this.parsePdf,
        log: this.log,
      });
    } catch (e) {
      this.log.info('psyarxiv fullText failed', { sourceId: paper.sourceId, err: (e as Error)?.message ?? String(e) });
      return null;
    }
  }
}
