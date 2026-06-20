import { RateLimiter } from '../util/rate-limiter';
import { Paper } from '../types';
import { Source } from './source';
import { Logger, noopLogger } from '../util/logger';
import { fetchAndParsePdf } from './pdf';

const BASE = 'https://api.osf.io/v2/preprints/';

// OSF API v2 preprint record (only the fields we read). The guid is `id`; topical text lives under
// `attributes`. Verified against a live `?filter[provider]=psyarxiv` response.
interface OsfRecord { id: string; attributes?: { title?: string; description?: string } }
interface OsfPage { data?: OsfRecord[] }

/** Bearer auth when a token is configured; OSF works anonymously otherwise (lower rate limit). */
function authInit(token?: string): RequestInit | undefined {
  return token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;
}

export interface PsyArxivDeps {
  fetchFn?: typeof fetch;
  token?: string;          // OSF personal token -> higher rate limit; from OSF_TOKEN
  minIntervalMs?: number;  // default 1000ms (OSF anonymous is rate-limited)
  pageSize?: number;       // default 50 matches per phrase request
  maxPdfBytes?: number;
  maxTextChars?: number;
  parsePdf?: (buf: Uint8Array) => Promise<string>;
  log?: Logger;
}

/**
 * PsyArXiv as a topical {@link Source} (ADR-0039). OSF's `/v2/preprints/` has no `filter[q]` (a live
 * probe returns HTTP 400), so each core phrase is searched with `filter[description][icontains]` and
 * the results are merged — a server-side query over ALL history, replacing the old recency window and
 * its bulk fetch. `hydrate` is identity; `fullText` resolves the OSF primary-file download and parses
 * it via the shared PDF helper (RESEARCH_PDF_DIR tee included). Everything fail-soft.
 */
export class PsyArxivSource implements Source {
  readonly kind = 'psyarxiv' as const;
  private readonly fetchFn: typeof fetch;
  private readonly token?: string;
  private readonly limiter: RateLimiter;
  private readonly pageSize: number;
  private readonly maxPdfBytes: number;
  private readonly maxTextChars: number;
  private readonly parsePdf?: (buf: Uint8Array) => Promise<string>;
  private readonly log: Logger;

  constructor(deps: PsyArxivDeps = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.token = deps.token ?? (process.env.OSF_TOKEN || undefined);
    this.limiter = new RateLimiter(deps.minIntervalMs ?? 1000);
    this.pageSize = deps.pageSize ?? 50;
    this.maxPdfBytes = deps.maxPdfBytes ?? 10_000_000;
    this.maxTextChars = deps.maxTextChars ?? 50_000;
    this.parsePdf = deps.parsePdf;
    this.log = deps.log ?? noopLogger;
  }

  private getJson<T>(url: string): Promise<T> {
    return this.limiter.schedule(async () => {
      const res = await this.fetchFn(url, authInit(this.token));
      if (!res.ok) throw new Error(`OSF HTTP ${res.status}`);
      return (await res.json()) as T;
    });
  }

  private toPaper(r: OsfRecord): Paper {
    return {
      sourceId: `osf:${r.id}`,
      sourceKind: 'psyarxiv',
      title: r.attributes?.title ?? '',
      abstract: r.attributes?.description ?? '',
      url: `https://osf.io/${r.id}`,
      pubTypes: [],
      isPreprint: true,
    };
  }

  /** One `filter[description][icontains]` request per core phrase (newline-joined by the OSF adapter),
   * merged + deduped by guid, capped at `limit`. Topical, all-history — no window pre-fetch. */
  async search(query: string, limit: number): Promise<Paper[]> {
    const phrases = query.split('\n').map((p) => p.trim()).filter(Boolean);
    if (phrases.length === 0) return [];
    const byGuid = new Map<string, Paper>();

    for (const phrase of phrases) {
      if (byGuid.size >= limit) break;
      const u = new URL(BASE);
      u.searchParams.set('filter[provider]', 'psyarxiv');
      u.searchParams.set('filter[description][icontains]', phrase);
      u.searchParams.set('sort', '-date_published'); // newest matching first
      u.searchParams.set('page[size]', String(this.pageSize));
      try {
        const data = await this.getJson<OsfPage>(u.toString());
        for (const r of data.data ?? []) {
          const paper = this.toPaper(r);
          if (r?.id && !byGuid.has(paper.sourceId)) byGuid.set(paper.sourceId, paper);
          if (byGuid.size >= limit) break;
        }
      } catch (e) {
        this.log.info('psyarxiv search phrase failed', { phrase, err: (e as Error)?.message ?? String(e) });
        // fail-soft: keep phrases already gathered
      }
    }
    return [...byGuid.values()].slice(0, limit);
  }

  /** Identity — the search result already carries title + abstract (ADR-0036). */
  async hydrate(paper: Paper): Promise<Paper> {
    return paper;
  }

  /** Resolve `osf:<guid>` → preprint detail → primary_file → `links.download`, then parse via the
   * shared PDF helper. Fail-safe to null so the agent falls back to the abstract. */
  async fullText(paper: Paper): Promise<string | null> {
    let pdf: string | null = null;
    try {
      const guid = paper.sourceId.replace(/^osf:/, '');
      const detail = await this.getJson<{
        data?: { relationships?: { primary_file?: { links?: { related?: { href?: string } } } } };
      }>(`${BASE}${guid}/`);
      const fileHref = detail.data?.relationships?.primary_file?.links?.related?.href;
      if (fileHref) {
        const fileNode = await this.getJson<{ data?: { links?: { download?: string } } }>(fileHref);
        pdf = fileNode.data?.links?.download ?? null;
      }
    } catch (e) {
      this.log.info('psyarxiv pdfUrl failed', { sourceId: paper.sourceId, err: (e as Error)?.message ?? String(e) });
      return null;
    }
    if (!pdf) return null;
    return fetchAndParsePdf(pdf, {
      fetchFn: this.fetchFn,
      schedule: (fn) => this.limiter.schedule(fn),
      maxPdfBytes: this.maxPdfBytes,
      maxTextChars: this.maxTextChars,
      parsePdf: this.parsePdf,
      log: this.log,
    });
  }
}

/** Construct the PsyArXiv evidence source (ADR-0036). OSF token defaults to `OSF_TOKEN`, read lazily. */
export function createPsyArxivSource(deps: PsyArxivDeps = {}): Source {
  return new PsyArxivSource(deps);
}
