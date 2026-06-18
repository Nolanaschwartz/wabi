import { Source } from './source';
import {
  PreprintCtx,
  PreprintDeps,
  PreprintSpec,
  WindowedPreprintSource,
} from './windowed-preprint-source';

const BASE = 'https://api.medrxiv.org/details/medrxiv';
const PAGE = 100; // medRxiv details endpoint returns 100 records per cursor page.

interface MedrxivRecord { doi: string; title: string; abstract: string; date: string; version?: string }

/** Page through the whole recent window (the details endpoint returns only 100 records per cursor,
 * out of thousands), deduping by DOI and capping at maxRecords. medRxiv emits one row per version
 * (ascending); keep the HIGHEST so the current version is presented and fetched, not a superseded one.
 * The core caches the returned window so this cost is paid once per run, not once per topic. */
async function fetchWindow(from: string, to: string, ctx: PreprintCtx): Promise<MedrxivRecord[]> {
  const byDoi = new Map<string, MedrxivRecord>();
  let total = Infinity;
  let offset = 0;
  const maxPages = Math.ceil(ctx.caps.maxRecords / PAGE) + 1;

  for (let i = 0; i < maxPages; i++) {
    let recs: MedrxivRecord[];
    let pageTotal: number | undefined;
    try {
      const data = await ctx.schedule(async () => {
        const res = await ctx.fetchFn(`${BASE}/${from}/${to}/${offset}/json`);
        if (!res.ok) throw new Error(`medRxiv HTTP ${res.status}`);
        return (await res.json()) as { collection?: MedrxivRecord[]; messages?: { total?: number }[] };
      });
      recs = data.collection ?? [];
      pageTotal = data.messages?.[0]?.total;
    } catch (e) {
      // Keep whatever we already paged rather than losing the window to one bad page.
      ctx.log.info('medrxiv page failed', { offset, err: (e as Error)?.message ?? String(e) });
      break;
    }
    if (typeof pageTotal === 'number') total = pageTotal;

    let added = 0;
    for (const r of recs) {
      if (!r?.doi) continue;
      const existing = byDoi.get(r.doi);
      if (!existing) { byDoi.set(r.doi, r); added++; }
      else if (Number(r.version ?? 0) > Number(existing.version ?? 0)) byDoi.set(r.doi, r);
    }

    if (recs.length < PAGE) break;             // last (or only) page
    if (byDoi.size >= total) break;            // whole window covered
    if (byDoi.size >= ctx.caps.maxRecords) break; // hit the cap
    if (added === 0) break;                    // no progress (e.g. a mock that ignores the cursor)
    offset += recs.length;
  }

  const records = [...byDoi.values()];
  ctx.log.info('medrxiv window fetched', {
    window: `${from}/${to}`, records: records.length,
    total: Number.isFinite(total) ? total : records.length,
    capped: records.length >= ctx.caps.maxRecords,
  });
  return records;
}

/** The medRxiv half of a {@link WindowedPreprintSource}: cursor pagination, the `doi:` keyspace, and
 * the version-specific open-access PDF URL. Everything else (window cache, term-match search, identity
 * hydrate, PDF download/parse) lives in the core. */
const medrxivSpec: PreprintSpec<MedrxivRecord> = {
  kind: 'medrxiv',
  fetchWindow,
  toPaper(r) {
    return {
      sourceId: `doi:${r.doi}`,
      sourceKind: 'medrxiv',
      title: r.title,
      abstract: r.abstract,
      url: `https://www.medrxiv.org/content/${r.doi}`,
      pubTypes: [],
      isPreprint: true,
    };
  },
  // `<doi>v<version>.full.pdf`. The version comes from the window record (kept highest); when the doi
  // wasn't in the window (record undefined) fall back to v1.
  async pdfUrl(paper, record) {
    const doi = paper.sourceId.replace(/^doi:/, '');
    const version = record?.version ?? '1';
    return `https://www.medrxiv.org/content/${doi}v${version}.full.pdf`;
  },
};

/** Construct the medRxiv evidence source (ADR-0036). Env-derived caps resolved lazily by the core. */
export function createMedrxivSource(deps: PreprintDeps = {}): Source {
  return new WindowedPreprintSource(medrxivSpec, deps);
}
