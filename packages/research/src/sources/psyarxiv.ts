import { Source } from './source';
import {
  PreprintCtx,
  PreprintDeps,
  PreprintSpec,
  WindowedPreprintSource,
} from './windowed-preprint-source';

const BASE = 'https://api.osf.io/v2/preprints/';
const PAGE = 100; // OSF page[size] cap.

// OSF API v2 preprint record (only the fields we read). The guid is `id`; topical text lives under
// `attributes`. Verified against a live `?filter[provider]=psyarxiv` response.
interface OsfRecord { id: string; attributes?: { title?: string; description?: string; date_published?: string } }
interface OsfPage { data?: OsfRecord[]; links?: { next?: string | null } }

/** Bearer auth when a token is configured; OSF works anonymously otherwise (lower rate limit). */
function authInit(token?: string): RequestInit | undefined {
  return token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;
}

/** Source-specific config (the OSF token) binds into the spec closure here, so the generic core never
 * carries a PsyArXiv-only concern. */
export interface PsyArxivDeps extends PreprintDeps {
  token?: string; // OSF personal token -> higher rate limit; from OSF_TOKEN
}

function psyarxivSpec(token?: string): PreprintSpec<OsfRecord> {
  const firstPageUrl = (from: string): string => {
    const u = new URL(BASE);
    u.searchParams.set('filter[provider]', 'psyarxiv');
    u.searchParams.set('filter[date_published][gte]', from);
    u.searchParams.set('sort', '-date_published'); // newest first, so the maxRecords cap keeps recent ones
    u.searchParams.set('page[size]', String(PAGE));
    return u.toString();
  };
  const getJson = <T>(url: string, ctx: PreprintCtx): Promise<T> =>
    ctx.schedule(async () => {
      const res = await ctx.fetchFn(url, authInit(token));
      if (!res.ok) throw new Error(`OSF HTTP ${res.status}`);
      return (await res.json()) as T;
    });

  return {
    kind: 'psyarxiv',
    /** Page the recent PsyArXiv window following OSF's `links.next`, deduping by guid and capping at
     * maxRecords. Termination is driven by OSF's pagination link, not by "no new records this page":
     * with `sort=-date_published`, records sharing a date can straddle a page boundary, so an all-dup
     * page is not end-of-window. `maxPages` is the infinite-loop backstop. */
    async fetchWindow(from, _to, ctx) {
      const init = authInit(token);
      const byGuid = new Map<string, OsfRecord>();
      let url: string | null = firstPageUrl(from);
      const maxPages = Math.ceil(ctx.caps.maxRecords / PAGE) + 1;

      for (let i = 0; i < maxPages && url; i++) {
        let data: OsfPage;
        try {
          data = await ctx.schedule(async () => {
            const res = await ctx.fetchFn(url as string, init);
            if (!res.ok) throw new Error(`OSF HTTP ${res.status}`);
            return (await res.json()) as OsfPage;
          });
        } catch (e) {
          // Keep whatever we already paged rather than losing the window to one bad page.
          ctx.log.info('psyarxiv page failed', { url, err: (e as Error)?.message ?? String(e) });
          break;
        }

        for (const r of data.data ?? []) {
          if (r?.id && !byGuid.has(r.id)) byGuid.set(r.id, r);
        }

        if (byGuid.size >= ctx.caps.maxRecords) break; // hit the cap
        url = data.links?.next ?? null;
      }

      const records = [...byGuid.values()];
      ctx.log.info('psyarxiv window fetched', { from, records: records.length, capped: records.length >= ctx.caps.maxRecords });
      return records;
    },
    toPaper(r) {
      return {
        sourceId: `osf:${r.id}`,
        sourceKind: 'psyarxiv',
        title: r.attributes?.title ?? '',
        abstract: r.attributes?.description ?? '',
        url: `https://osf.io/${r.id}`,
        pubTypes: [],
        isPreprint: true,
      };
    },
    /** Resolve `osf:<guid>` → preprint detail → `primary_file` file node → `links.download`. Fail-safe:
     * any HTTP/missing-link failure → null → the core falls back to the abstract. */
    async pdfUrl(paper, _record, ctx) {
      try {
        const guid = paper.sourceId.replace(/^osf:/, '');
        const detail = await getJson<{
          data?: { relationships?: { primary_file?: { links?: { related?: { href?: string } } } } };
        }>(`${BASE}${guid}/`, ctx);
        const fileHref = detail.data?.relationships?.primary_file?.links?.related?.href;
        if (!fileHref) return null;

        const fileNode = await getJson<{ data?: { links?: { download?: string } } }>(fileHref, ctx);
        return fileNode.data?.links?.download ?? null;
      } catch (e) {
        ctx.log.info('psyarxiv pdfUrl failed', { sourceId: paper.sourceId, err: (e as Error)?.message ?? String(e) });
        return null;
      }
    },
  };
}

/** Construct the PsyArXiv evidence source (ADR-0036). The OSF token defaults to `OSF_TOKEN`, read
 * lazily here (per-run, after ConfigModule loads), never frozen at import. */
export function createPsyArxivSource(deps: PsyArxivDeps = {}): Source {
  const token = deps.token ?? (process.env.OSF_TOKEN || undefined);
  return new WindowedPreprintSource(psyarxivSpec(token), deps);
}
