# PsyArXiv Source + Full-Text for All Research Sources — Design Spec

**Date:** 2026-06-17
**Status:** Approved (design)
**Scope:** `@wabi/research` package only. No `@wabi/shared`, `@wabi/bot`, or Prisma changes.
**Related:** ADR-0012 (human review of strategy drafts), ADR-0034 (research worker topology), ADR-0002/0033 (worker→bot coupling).

## Goal

Two related changes to the research worker:

1. **Add PsyArXiv** (psychology preprints, hosted on OSF) as a third evidence source alongside
   PubMed and medRxiv. PsyArXiv is the most on-domain corpus for the behavior-change / CBT /
   ACT / mindfulness / motivation techniques Wabi coaches with, which PubMed under-indexes.
2. **Ensure every source extracts from full text, not just the abstract,** wherever full text
   is legitimately available:
   - **PsyArXiv** — fetch & parse the full-text PDF (new).
   - **medRxiv** — fetch & parse the `.full.pdf` (currently deferred; returns `null` → abstract).
   - **PubMed** — keep PMC open-access BioC JSON as primary; add a Europe PMC OA full-text
     fallback for OA articles BioC misses.

All full-text paths are **fail-safe**: any failure yields `null` and the agent falls back to
the abstract, matching the existing `pubmed.fullText` contract. Non-OA / paywalled articles are
*not* scraped — the abstract fallback is the correct and only legal behavior there.

## Non-goals

- No change to the bot's strategy-admin ingest API or the `StrategyDraft`/`ProcessedSource`
  schema. Confirmed: the bot accepts `sourceKind` as a free-text string (no enum validation)
  and stores it as `ProcessedSource.source` (`String`). All changes are self-contained to the
  research package.
- No generalization to a `PreprintSource[]` array yet. PsyArXiv wires in as an explicit third
  dep, mirroring the current code. Generalizing is the natural next step when a fourth source
  (e.g. bioRxiv, OpenAlex) lands.
- No attempt to obtain full text for paywalled / non-OA articles (copyright). Abstract fallback.

## Context: how sources work today

- `src/types.ts` — `SourceKind = 'pubmed' | 'medrxiv'`; `Paper` carries `sourceId`,
  `sourceKind`, `title`, `abstract`, `url`, `pubTypes`, `isPreprint`.
- `src/sources/pubmed.ts` — `PubMedTool`: `search` (PMIDs), `summary`, `abstract`, `related`,
  `fullText` (PMC OA via BioC JSON; `null` when not OA / not in BioC → caller uses abstract).
- `src/sources/medrxiv.ts` — `MedrxivTool`: `search` returns `Paper[]` by paging a recent
  date-window, caching per-run, scoring query content-terms locally (stopwords dropped,
  `minTermFraction` of terms required, whole-word matching). `fullText` returns `null`
  (deferred). The cached `MedrxivRecord` is `{ doi, title, abstract, date }`.
- `src/agent/research-agent.ts` — `ResearchAgent` hard-codes `pubmed` + `medrxiv`. Per paper:
  `seen` skip → relevance gate → (PubMed-only) discovery expansion → full-text fetch
  (`body = full ?? abstract`) → extract → in-run dedup → collect. The full-text branch is
  `pubmed ? pubmed.fullText : medrxiv.fullText` — the `else` catches every non-PubMed kind.
- `src/run-service/research-runner.service.ts` — `defaultBuildAgent` constructs the tools and
  injects them into a fresh `ResearchAgent` per topic.

## Design

### 1. Shared `src/sources/pdf.ts`

Both PsyArXiv and medRxiv fetch a PDF and turn it into capped plain text, so this lives once:

```
interface FetchPdfOpts {
  fetchFn: typeof fetch;
  schedule: <T>(fn: () => Promise<T>) => Promise<T>;  // the calling tool's RateLimiter.schedule
  maxPdfBytes: number;
  maxTextChars: number;
  parsePdf?: (buf: Uint8Array) => Promise<string>;     // default: unpdf extractText, pages joined "\n"
  log?: Logger;
}

// Returns capped plain text, or null on ANY failure (HTTP, oversize, parse error, empty).
async function fetchAndParsePdf(url: string, opts: FetchPdfOpts): Promise<string | null>
```

Behavior: schedule the download through the caller's rate limiter; reject (→`null`) when
`Content-Length` or the received byte length exceeds `maxPdfBytes`; `parsePdf` the bytes; trim
and truncate to `maxTextChars`; return `null` if empty. All errors caught → `null`. The
`parsePdf` seam keeps `unpdf` swappable and lets unit tests stub parsing.

### 2. `src/sources/term-match.ts` (extracted shared helper)

Exports the stopword set, `contentTerms(query)`, `escapeRegExp(s)`, and the `scoreRecord` /
`minMatch` logic currently inline in `medrxiv.ts`. `medrxiv.ts` is refactored to import these
(behavior-preserving — existing `medrxiv.spec.ts` stays green); `psyarxiv.ts` imports the same.

### 3. `src/sources/psyarxiv.ts` — `PsyArxivTool`

Source: **OSF API v2** — `https://api.osf.io/v2/preprints/?filter[provider]=psyarxiv`.

Constructor deps (mirrors `MedrxivDeps`), all injectable:

```
interface PsyArxivDeps {
  fetchFn?: typeof fetch;
  token?: string;            // OSF personal token -> higher rate limit; from OSF_TOKEN
  minIntervalMs?: number;    // default 1000
  windowDays?: number;       // default 60; env RESEARCH_PSYARXIV_WINDOW_DAYS
  maxRecords?: number;       // default 1500; env RESEARCH_PSYARXIV_MAX_RECORDS
  minTermFraction?: number;  // default 0.5; env RESEARCH_PSYARXIV_MIN_TERM_FRACTION
  maxPdfBytes?: number;      // default 20_000_000; env RESEARCH_PSYARXIV_MAX_PDF_BYTES
  maxTextChars?: number;     // default 50_000; env RESEARCH_PSYARXIV_MAX_TEXT_CHARS
  parsePdf?: (buf: Uint8Array) => Promise<string>;
  now?: () => Date;
  log?: Logger;
}
```

**`search(query, limit): Promise<Paper[]>`** — mirrors `MedrxivTool.search`:
1. Window `[now - windowDays, now]`.
2. Page the OSF endpoint filtered by `provider=psyarxiv` + `date_published>=from`, following
   `links.next`, deduping by guid, capping at `maxRecords`, cached per-window per-run.
   `Authorization: Bearer <token>` when `OSF_TOKEN` is set.
3. Score `title + description` against query content-terms via `term-match.ts`.
4. Return top `limit` as `Paper`: `sourceId: 'osf:<guid>'`, `sourceKind: 'psyarxiv'`,
   `title` ← `attributes.title`, `abstract` ← `attributes.description`,
   `url: 'https://osf.io/<guid>'`, `pubTypes: []`, `isPreprint: true`.

**Why `osf:<guid>`:** the guid is always present (DOI sometimes isn't), stable/unique for the
`seen()`/`ProcessedSource` ledger, and `fullText` recovers it from the prefix. Each source owns
its own id keyspace (`PMID:`, `doi:`, `osf:`); the ledger is keyed per-source-id.

**`fullText(sourceId): Promise<string | null>`:**
1. Strip `osf:` → guid.
2. `GET /v2/preprints/<guid>/` → `relationships.primary_file.links.related.href` → `GET` that
   file node → `data.links.download`.
3. `fetchAndParsePdf(downloadUrl, { ...caps, schedule: limiter.schedule, parsePdf })`.

The OSF JSON paths are validated against a recorded live response in a fixtures spec.

### 4. `medrxiv.ts` — implement `fullText` via the PDF path

- Add `version` to `MedrxivRecord` (the details API returns it) and carry it on the cached
  record. (medRxiv `search` still returns `Paper` keyed `doi:<doi>` as today — `Paper` itself is
  unchanged; the version is kept in the tool's per-run record cache, keyed by `doi`.)
- **`fullText(sourceId)`**: strip `doi:` → doi; look up the cached record's version; build
  `https://www.medrxiv.org/content/<doi>v<version>.full.pdf` (fall back to `v1` when version is
  unknown); call `fetchAndParsePdf` with medRxiv caps. Fail-safe → `null` → abstract.
- New env knobs: `RESEARCH_MEDRXIV_MAX_PDF_BYTES` (default 20_000_000),
  `RESEARCH_MEDRXIV_MAX_TEXT_CHARS` (default 50_000).
- Note: `fullText` is only called for kept papers within the same run, so the version is in the
  per-run cache. If a cache miss ever occurs, fall back to the `v1` URL rather than failing.

### 5. `pubmed.ts` — Europe PMC OA fallback + truncation

- `fullText(pmid)` keeps BioC JSON as primary (unchanged). **When BioC yields `null`**, and a
  PMCID is known (already fetched from `esummary` `articleids`), try Europe PMC OA full text:
  `GET https://www.ebi.ac.uk/europepmc/webservices/rest/<PMCID>/fullTextXML` → strip XML tags to
  plain text (a small `stripXml` helper; the LLM extractor tolerates residual markup) → use it.
- Apply a `maxTextChars` truncation (env `RESEARCH_PUBMED_MAX_TEXT_CHARS`, default 50_000) to
  the returned full text from **either** path — a behavior change to the existing BioC path,
  added to bound token cost consistently with the other sources.
- Both paths fail-safe → `null` → abstract. Non-OA articles (no PMCID) skip straight to `null`.

### 6. `research-agent.ts` — explicit third dep + per-kind full-text routing

- `AgentDeps` gains `psyarxiv: MedrxivLike` (same `{ search, fullText }` shape).
- After the medrxiv search, add
  `const psyPapers = await this.deps.psyarxiv.search(topic, maxPapersPerTopic).catch(() => [])`
  and spread into the queue as `kind: 'psyarxiv'`. Update the `search done` log to include it.
- **Replace the binary full-text branch** with explicit per-kind routing (today's `else` would
  mis-route PsyArXiv papers to `medrxiv.fullText`):
  ```
  let full: string | null = null;
  if (paper.sourceKind === 'pubmed')        full = await deps.pubmed.fullText(pmid).catch(() => null);
  else if (paper.sourceKind === 'medrxiv')  full = await deps.medrxiv.fullText(paper.sourceId).catch(() => null);
  else if (paper.sourceKind === 'psyarxiv') full = await deps.psyarxiv.fullText(paper.sourceId).catch(() => null);
  ```
- Discovery expansion remains PubMed-only (unchanged).

### 7. Types & wiring

- `src/types.ts`: `SourceKind = 'pubmed' | 'medrxiv' | 'psyarxiv'`.
- `research-runner.service.ts` `defaultBuildAgent`: construct
  `new PsyArxivTool({ token: process.env.OSF_TOKEN, log })` and pass `psyarxiv` into deps.
- `package.json`: add `unpdf` to `dependencies`.
- `.env.example` + `packages/research/README.md`: document `RESEARCH_PSYARXIV_*`,
  `RESEARCH_MEDRXIV_MAX_PDF_BYTES`/`MAX_TEXT_CHARS`, `RESEARCH_PUBMED_MAX_TEXT_CHARS`, `OSF_TOKEN`.

## Data flow

```
topic
  ├─ pubmed.search   → PMIDs
  ├─ medrxiv.search  → Paper[]  (doi: ids; version cached)
  └─ psyarxiv.search → Paper[]  (osf: ids)
        → queue → per paper:
             seen? skip
             relevanceGate(abstract)
             [pubmed only] discovery expansion via related()
             fullText (fail-safe → null → abstract):
               pubmed   → BioC JSON → (null) Europe PMC fullTextXML → truncate
               medrxiv  → <doi>vN.full.pdf → fetchAndParsePdf
               psyarxiv → OSF primary_file PDF → fetchAndParsePdf
             extract(paper, body) → candidate
             in-run dedup → collect
  → runResearch submits each candidate to bot /admin/strategies/ingest
```

## Error handling & safety

- Preprints (medRxiv, PsyArXiv) carry `isPreprint: true`, are un-peer-reviewed, and every
  candidate still passes the relevance gate and lands as a pending `StrategyDraft` for human
  review (ADR-0012).
- All full-text paths are fail-safe: HTTP error, missing file, oversized PDF, parse failure,
  empty text → `null` → abstract. A paper is never dropped solely because its full text failed.
- `maxPdfBytes` / `maxTextChars` bound memory and token cost per paper; the per-run
  `tokenBudget` and `agentTimeoutMs` remain global backstops.
- Rate limiting honored per source via `RateLimiter`; OSF uses optional `OSF_TOKEN`.
- No paywalled-content scraping. PubMed non-OA → abstract.

## Testing (TDD — write specs first)

- `src/sources/__tests__/pdf.spec.ts` — `fetchAndParsePdf`: happy path with stubbed `parsePdf`;
  `maxPdfBytes` skip → `null`; `maxTextChars` truncation; fail-safe → `null` on each failure.
- `src/sources/__tests__/term-match.spec.ts` — extracted helper; `medrxiv.spec.ts` stays green
  (proves the refactor is behavior-preserving).
- `src/sources/__tests__/psyarxiv.spec.ts` — fixture OSF JSON: window paging + guid dedup +
  `maxRecords` cap; term-scoring; `Paper` mapping (`osf:` id, `psyarxiv`, `isPreprint`);
  `fullText` resolves preprint→file→download and calls the shared helper (stubbed `parsePdf`).
- `src/sources/__tests__/psyarxiv.fixtures.spec.ts` — real `unpdf` parse over a small committed
  PDF fixture (mirrors existing `*.fixtures.spec.ts`). The same fixture covers medRxiv parsing.
- `src/sources/__tests__/medrxiv.spec.ts` — **update**: `fullText` now builds the `vN.full.pdf`
  URL from doi+version and returns parsed text (mock fetch + stub `parsePdf`); `v1` fallback;
  fail-safe → `null`. (Replaces the current "returns null" assertion.)
- `src/sources/__tests__/pubmed.spec.ts` — **update**: BioC primary unchanged; Europe PMC
  fallback invoked when BioC returns `null` and a PMCID exists; XML stripped to text;
  truncation applied; non-OA (no PMCID) → `null`; fail-safe.
- `src/agent/__tests__/research-agent.spec.ts` — extend with a `psyarxiv` fake: its papers get
  queued/processed; `psyarxiv.fullText` (not `medrxiv.fullText`) is called for `psyarxiv` papers;
  abstract fallback when `fullText` returns `null`.
- `pnpm -F research test` green; spot-check `pnpm -F research build`.

## Rollout

Single PR off a new branch. No migration, no bot deploy coupling. The worker picks up the new
source and full-text paths on next run; with no `OSF_TOKEN` set PsyArXiv still works at the
unauthenticated rate limit.
