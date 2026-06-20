import { RateLimiter } from '../util/rate-limiter';
import { Paper } from '../types';
import { Source } from './source';
import { Logger, noopLogger } from './../util/logger';
import { fetchAndParsePdf } from './pdf';

const SEARCH = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';

/** One Europe PMC `core` search result (the fields we use; many more exist). */
interface EpmcResult {
  id?: string;
  source?: string;
  pmid?: string;
  doi?: string;
  title?: string;
  abstractText?: string;
  fullTextUrlList?: { fullTextUrl?: { documentStyle?: string; url?: string }[] };
}
interface EpmcResponse {
  nextCursorMark?: string;
  resultList?: { result?: EpmcResult[] };
}

export interface EuropePmcDeps {
  fetchFn?: typeof fetch;
  minIntervalMs?: number;     // default 350ms — Europe PMC is generous; matches the PubMed cadence
  pageSize?: number;          // default 100 (EPMC cap is 1000); we usually need one page
  maxPdfBytes?: number;
  maxTextChars?: number;
  parsePdf?: (buf: Uint8Array) => Promise<string>;
  log?: Logger;
}

/**
 * Europe PMC as a topical {@link Source} for preprints (medRxiv/bioRxiv, `SRC:PPR`). Unlike the old
 * windowed sources, this issues a server-side query and takes the most relevant results across ALL
 * history — no bulk window fetch, no local term-match (ADR-0039). `search` follows `cursorMark` until
 * `limit`; `hydrate` is identity (the `core` result already carries title/abstract); `fullText` parses
 * the result's open-access PDF when present. Everything fail-safe — a bad page/PDF yields fewer/none,
 * never an abort.
 */
export class EuropePmcSource implements Source {
  readonly kind = 'europepmc' as const;
  private readonly fetchFn: typeof fetch;
  private readonly limiter: RateLimiter;
  private readonly pageSize: number;
  private readonly maxPdfBytes: number;
  private readonly maxTextChars: number;
  private readonly parsePdf?: (buf: Uint8Array) => Promise<string>;
  private readonly log: Logger;
  // sourceId -> the result, so fullText can find the PDF url from the paper that search returned.
  private byId = new Map<string, EpmcResult>();

  constructor(deps: EuropePmcDeps = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.limiter = new RateLimiter(deps.minIntervalMs ?? 350);
    this.pageSize = deps.pageSize ?? 100;
    this.maxPdfBytes = deps.maxPdfBytes ?? 10_000_000;
    this.maxTextChars = deps.maxTextChars ?? 50_000;
    this.parsePdf = deps.parsePdf;
    this.log = deps.log ?? noopLogger;
  }

  private toPaper(r: EpmcResult): Paper {
    const sourceId = r.doi ? `doi:${r.doi}` : `epmc:${r.source ?? 'PPR'}/${r.id ?? ''}`;
    const url = r.doi ? `https://doi.org/${r.doi}` : `https://europepmc.org/article/${r.source ?? 'PPR'}/${r.id ?? ''}`;
    return {
      sourceId,
      sourceKind: 'europepmc',
      title: r.title ?? '',
      abstract: r.abstractText ?? '',
      url,
      pubTypes: [],
      isPreprint: true, // SRC:PPR — tier resolves to 'preprint' via isPreprint (extract.evidenceTier)
    };
  }

  /** Topical SRC:PPR search, relevance-ranked (EPMC default), paged via cursorMark up to `limit`. */
  async search(query: string, limit: number): Promise<Paper[]> {
    if (!query.trim()) return [];
    this.byId = new Map();
    const papers: Paper[] = [];
    let cursor = '*';
    // Guard the loop: stop at limit, when the cursor stops advancing, or after enough pages for `limit`.
    const maxPages = Math.ceil(limit / this.pageSize) + 1;
    for (let i = 0; i < maxPages && papers.length < limit; i++) {
      const url =
        `${SEARCH}?query=${encodeURIComponent(`${query} AND (SRC:PPR)`)}` +
        `&format=json&resultType=core&pageSize=${this.pageSize}&cursorMark=${encodeURIComponent(cursor)}`;
      let data: EpmcResponse;
      try {
        data = await this.limiter.schedule(async () => {
          // Retry transient 5xx (EPMC 503s intermittently) before giving up — one blip otherwise
          // zeroes the source for the whole topic. 4xx and parse errors are not retried.
          for (let attempt = 0; ; attempt++) {
            const res = await this.fetchFn(url);
            if (res.ok) return (await res.json()) as EpmcResponse;
            if (res.status >= 500 && attempt < 2) {
              await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
              continue;
            }
            throw new Error(`Europe PMC HTTP ${res.status}`);
          }
        });
      } catch (e) {
        this.log.info('europepmc search page failed', { err: (e as Error)?.message ?? String(e) });
        break; // fail-soft: return what we have
      }
      const results = data.resultList?.result ?? [];
      for (const r of results) {
        const paper = this.toPaper(r);
        if (this.byId.has(paper.sourceId)) continue;
        this.byId.set(paper.sourceId, r);
        papers.push(paper);
        if (papers.length >= limit) break;
      }
      const next = data.nextCursorMark;
      if (!next || next === cursor || results.length === 0) break; // no progress
      cursor = next;
    }
    return papers;
  }

  /** Identity — the `core` search result already carries title + abstract (ADR-0036). */
  async hydrate(paper: Paper): Promise<Paper> {
    return paper;
  }

  /** Open-access PDF (when the result advertises one), parsed via the shared PDF helper (which also
   * tees to RESEARCH_PDF_DIR). Fail-safe to null so the agent falls back to the abstract. */
  async fullText(paper: Paper): Promise<string | null> {
    const r = this.byId.get(paper.sourceId);
    const pdf = r?.fullTextUrlList?.fullTextUrl?.find((u) => u.documentStyle === 'pdf' && u.url)?.url;
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
