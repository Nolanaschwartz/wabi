import { RateLimiter } from '../util/rate-limiter';
import { Paper, SourceKind } from '../types';
import { Source } from './source';
import { Logger, noopLogger } from '../util/logger';
import { contentTerms, minMatch, scoreRecord } from './term-match';
import { fetchAndParsePdf } from './pdf';
import { SourceConfig, loadSourceConfig } from '../config';

/** Sources this core serves: the windowed preprint corpora (medRxiv, PsyArXiv). PubMed is id-based,
 * not window-scanned, so it is NOT one of these (ADR-0036). */
type WindowedKind = 'medrxiv' | 'psyarxiv';

/** Everything a {@link PreprintSpec} hook needs from the core: the shared fetch + rate limiter, the
 * resolved tuning caps, and the PDF parser. Built once per source and handed to every hook call. */
export interface PreprintCtx {
  fetchFn: typeof fetch;
  schedule: <T>(fn: () => Promise<T>) => Promise<T>; // the source's RateLimiter.schedule
  caps: SourceConfig;
  parsePdf?: (buf: Uint8Array) => Promise<string>;
  log: Logger;
}

/**
 * The per-source half of a windowed preprint {@link Source}: only what genuinely differs between
 * medRxiv and PsyArXiv. The {@link WindowedPreprintSource} core owns the rest (config/caps, the
 * window cache, term-match search, identity hydrate, PDF download/parse + caps).
 */
export interface PreprintSpec<R> {
  readonly kind: SourceKind;
  /** Page the recency window [from, to] (ISO dates), deduped and capped at `ctx.caps.maxRecords`.
   * Owns its own pagination (cursor for medRxiv, `links.next` for OSF). */
  fetchWindow(from: string, to: string, ctx: PreprintCtx): Promise<R[]>;
  /** Raw record → normalized Paper, setting the id keyspace (`doi:`/`osf:`) and url. */
  toPaper(record: R): Paper;
  /** Resolve the open-access PDF download URL (may do extra hops via `ctx`), or null when there is
   * none. Gets the stable {@link Paper} plus the raw record when the paper came from this window
   * (undefined otherwise — e.g. medRxiv then falls back to v1). */
  pdfUrl(paper: Paper, record: R | undefined, ctx: PreprintCtx): Promise<string | null>;
}

/** Construction seams. Env-derived caps come from `config.ts` (`loadSourceConfig`), each overridable
 * for tests; resolved lazily here (constructed per-run after ConfigModule loads), never at import. */
export interface PreprintDeps {
  fetchFn?: typeof fetch;
  minIntervalMs?: number;
  windowDays?: number;
  maxRecords?: number;
  minTermFraction?: number;
  maxPdfBytes?: number;
  maxTextChars?: number;
  parsePdf?: (buf: Uint8Array) => Promise<string>;
  now?: () => Date;
  log?: Logger;
}

/**
 * The deep core behind medRxiv and PsyArXiv (ADR-0036). It owns the window cache (paid once per run,
 * shared across topics), the shared term-match search, identity hydrate, and the PDF
 * download/parse/cap delegation — so a window/cache/scoring bug is fixed once. Each source supplies a
 * small {@link PreprintSpec} for the parts that actually differ.
 */
export class WindowedPreprintSource<R> implements Source {
  readonly kind: SourceKind;
  private readonly limiter: RateLimiter;
  private readonly caps: SourceConfig;
  private readonly now: () => Date;
  private readonly log: Logger;
  private readonly ctx: PreprintCtx;
  // The fetched window, cached so every topic in a run filters the SAME records without re-paginating.
  // `byId` indexes the raw records by their Paper sourceId so fullText can look the record back up.
  private cache: { key: string; records: R[]; byId: Map<string, R> } | null = null;

  constructor(private readonly spec: PreprintSpec<R>, deps: PreprintDeps = {}) {
    const cfg = loadSourceConfig(spec.kind as WindowedKind);
    this.kind = spec.kind;
    this.limiter = new RateLimiter(deps.minIntervalMs ?? 1000);
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? noopLogger;
    this.caps = {
      windowDays: deps.windowDays ?? cfg.windowDays,
      maxRecords: deps.maxRecords ?? cfg.maxRecords,
      minTermFraction: deps.minTermFraction ?? cfg.minTermFraction,
      maxPdfBytes: deps.maxPdfBytes ?? cfg.maxPdfBytes,
      maxTextChars: deps.maxTextChars ?? cfg.maxTextChars,
    };
    this.ctx = {
      fetchFn: deps.fetchFn ?? fetch,
      schedule: (fn) => this.limiter.schedule(fn),
      caps: this.caps,
      parsePdf: deps.parsePdf,
      log: this.log,
    };
  }

  private fmt(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  /** Fetch (or reuse) the recent window for the current clock, memoized by its date key. */
  private async window(): Promise<{ records: R[]; byId: Map<string, R> }> {
    const to = this.now();
    const from = new Date(to.getTime() - this.caps.windowDays * 86_400_000);
    const key = `${this.fmt(from)}/${this.fmt(to)}`;
    if (this.cache?.key === key) return this.cache;

    const records = await this.spec.fetchWindow(this.fmt(from), this.fmt(to), this.ctx);
    const byId = new Map<string, R>();
    for (const r of records) byId.set(this.spec.toPaper(r).sourceId, r);
    this.cache = { key, records, byId };
    return this.cache;
  }

  /** Keep records containing ENOUGH of the query's content terms, ranked by how many match, capped to
   * `limit`. Shared scoring (term-match.ts) so every windowed source ranks identically. */
  async search(query: string, limit: number): Promise<Paper[]> {
    const { records } = await this.window();
    const terms = contentTerms(query);
    const need = minMatch(terms.length, this.caps.minTermFraction);

    return records
      .map((r) => {
        const paper = this.spec.toPaper(r);
        return { paper, score: scoreRecord(`${paper.title} ${paper.abstract}`, terms) };
      })
      .filter((x) => x.score >= need)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.paper);
  }

  /** Preprint list endpoints already return complete papers, so hydrate is the identity (ADR-0036). */
  async hydrate(paper: Paper): Promise<Paper> {
    return paper;
  }

  /** Open-access full text via the source's PDF, through the shared fetch/parse/cap helper. The raw
   * record (carrying e.g. medRxiv's version) is looked up from the primed window; absent → the spec
   * resolves from the paper alone. Fail-safe: any failure → null and the agent reads the abstract. */
  async fullText(paper: Paper): Promise<string | null> {
    const record = this.cache?.byId.get(paper.sourceId);
    const url = await this.spec.pdfUrl(paper, record, this.ctx);
    if (!url) return null;
    return fetchAndParsePdf(url, {
      fetchFn: this.ctx.fetchFn,
      schedule: this.ctx.schedule,
      maxPdfBytes: this.caps.maxPdfBytes,
      maxTextChars: this.caps.maxTextChars,
      parsePdf: this.ctx.parsePdf,
      log: this.log,
    });
  }
}
