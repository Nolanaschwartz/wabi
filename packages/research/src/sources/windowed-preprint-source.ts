import { RateLimiter } from '../util/rate-limiter';
import { Paper, SourceKind } from '../types';
import { Source } from './source';
import { Logger, noopLogger } from '../util/logger';
import { contentTerms, idf, minMatch, scoreRecord, weightedScore } from './term-match';
import { fetchAndParsePdf } from './pdf';
import { SourceConfig, loadSourceConfig } from '../config';

/** Everything a {@link PreprintSpec} hook needs from the core: the shared fetch + rate limiter, the
 * resolved tuning caps, and the logger. Built once per source and handed to every hook call. */
export interface PreprintCtx {
  fetchFn: typeof fetch;
  schedule: <T>(fn: () => Promise<T>) => Promise<T>; // the source's RateLimiter.schedule
  caps: SourceConfig;
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
  private readonly parsePdf?: (buf: Uint8Array) => Promise<string>;
  private readonly ctx: PreprintCtx;
  // The fetched window, cached so every topic in a run filters the SAME records without re-paginating.
  // Indexed by Paper sourceId (Map keeps insertion order, so it doubles as the record list) so
  // fullText can look the raw record back up.
  private cache: { key: string; byId: Map<string, R> } | null = null;

  constructor(private readonly spec: PreprintSpec<R>, deps: PreprintDeps = {}) {
    const cfg = loadSourceConfig(spec.kind as 'medrxiv' | 'psyarxiv');
    this.kind = spec.kind;
    this.limiter = new RateLimiter(deps.minIntervalMs ?? 1000);
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? noopLogger;
    this.parsePdf = deps.parsePdf;
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
      log: this.log,
    };
  }

  private fmt(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  /** Fetch (or reuse) the recent window for the current clock, memoized by its date key. */
  private async window(): Promise<Map<string, R>> {
    const to = this.now();
    const from = new Date(to.getTime() - this.caps.windowDays * 86_400_000);
    const key = `${this.fmt(from)}/${this.fmt(to)}`;
    if (this.cache?.key === key) return this.cache.byId;

    const records = await this.spec.fetchWindow(this.fmt(from), this.fmt(to), this.ctx);
    const byId = new Map<string, R>();
    for (const r of records) byId.set(this.spec.toPaper(r).sourceId, r);
    this.cache = { key, byId };
    return byId;
  }

  /** Keep records containing ENOUGH of the query's content terms, ranked by match strength, capped to
   * `limit`. Shared scoring (term-match.ts) so every windowed source ranks identically.
   *
   * ≤2 terms: a flat whole-word count, require (near) all — a 1–2 word query is already specific.
   * ≥3 terms: rarity-weight the terms by IDF over THIS window, keep records reaching a fraction of the
   * query's total weight. Without weighting, a generic term ("cognitive") that matches a whole clinical
   * window lets dementia/neuro papers clear a flat count; weighting makes the rare topical terms
   * ("rumination", "reappraisal") carry the threshold so off-topic floods drop out. */
  async search(query: string, limit: number): Promise<Paper[]> {
    const byId = await this.window();
    const terms = contentTerms(query);
    const frac = this.caps.minTermFraction;
    const papers = [...byId.values()].map((r) => this.spec.toPaper(r));
    const docOf = (p: Paper) => `${p.title} ${p.abstract}`;

    let scored: { paper: Paper; score: number }[];
    let need: number;
    if (terms.length <= 2) {
      need = minMatch(terms.length, frac);
      scored = papers.map((paper) => ({ paper, score: scoreRecord(docOf(paper), terms) }));
    } else {
      const weights = idf(terms, papers.map(docOf));
      need = frac * terms.reduce((sum, t) => sum + (weights.get(t) ?? 0), 0);
      scored = papers.map((paper) => ({ paper, score: weightedScore(docOf(paper), terms, weights) }));
    }

    return scored
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
      parsePdf: this.parsePdf,
      log: this.log,
    });
  }
}
