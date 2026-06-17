# PsyArXiv Research Source — Design Spec

**Date:** 2026-06-17
**Status:** Approved (design)
**Scope:** `@wabi/research` package only. No `@wabi/shared`, `@wabi/bot`, or Prisma changes.
**Related:** ADR-0012 (human review of strategy drafts), ADR-0034 (research worker topology), ADR-0002/0033 (worker→bot coupling).

## Goal

Add **PsyArXiv** (psychology preprints, hosted on OSF) as a third evidence source for the
research worker, alongside the existing PubMed and medRxiv sources. PsyArXiv is the most
on-domain corpus for the behavior-change / CBT / ACT / mindfulness / motivation techniques
Wabi coaches with, which PubMed under-indexes relative to its clinical-medicine bias.

Unlike medRxiv (whose full-text fetch is deferred — it extracts from the abstract), the
PsyArXiv source **fetches and parses the full-text PDF** for richer extraction, falling back
to the abstract on any failure.

## Non-goals

- No change to the bot's strategy-admin ingest API or the `StrategyDraft`/`ProcessedSource`
  schema. Confirmed: the bot accepts `sourceKind` as a free-text string (no enum validation)
  and stores it as `ProcessedSource.source` (`String`). PsyArXiv is self-contained to the
  research package.
- No generalization to a `PreprintSource[]` array yet. PsyArXiv wires in as an explicit third
  dep, mirroring the current code. Generalizing is the natural next step when a fourth source
  (e.g. bioRxiv, OpenAlex) lands.
- No backfill of medRxiv full-text. That remains deferred.

## Context: how sources work today

- `packages/research/src/types.ts` — `SourceKind = 'pubmed' | 'medrxiv'`; `Paper` carries
  `sourceId`, `sourceKind`, `title`, `abstract`, `url`, `pubTypes`, `isPreprint`.
- `packages/research/src/sources/pubmed.ts` — `PubMedTool`: `search` (returns PMIDs),
  `summary`, `abstract`, `related`, `fullText` (PMC OA via BioC JSON; returns `null` when not
  available so the caller falls back to the abstract).
- `packages/research/src/sources/medrxiv.ts` — `MedrxivTool`: `search` returns `Paper[]` by
  paging a recent date-window, caching it per-run, and scoring query content-terms locally
  (stopwords dropped, `minTermFraction` of terms required, whole-word matching). `fullText`
  returns `null` (deferred).
- `packages/research/src/agent/research-agent.ts` — `ResearchAgent` hard-codes `pubmed` and
  `medrxiv` deps. It searches both, builds a queue, and per paper runs: `seen` skip →
  relevance gate → (PubMed-only) discovery expansion → full-text fetch (`body = full ??
  abstract`) → extract → in-run dedup → collect.
- `packages/research/src/run-service/research-runner.service.ts` — `defaultBuildAgent`
  constructs `PubMedTool` and `MedrxivTool` and injects them into a fresh `ResearchAgent` per
  topic.

## Design

### 1. `PsyArxivTool` (`src/sources/psyarxiv.ts`)

Source: **OSF API v2** — `https://api.osf.io/v2/preprints/?filter[provider]=psyarxiv`.

Constructor deps (mirrors `MedrxivDeps`), all injectable for tests:

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
  parsePdf?: (buf: Uint8Array) => Promise<string>;  // default: unpdf
  now?: () => Date;
  log?: Logger;
}
```

#### `search(query, limit): Promise<Paper[]>`

Mirrors `MedrxivTool.search` exactly in shape:

1. Compute window `[now - windowDays, now]`.
2. Page the OSF preprints endpoint filtered by `provider=psyarxiv` and
   `date_published>=from`, following `links.next`, deduping by guid, capping at `maxRecords`,
   cached per-window per-run. Send `Authorization: Bearer <token>` when `OSF_TOKEN` is set.
3. Score each record's `title + description` against the query's content-terms using the SAME
   logic as medRxiv (stopwords, length≥3, `minTermFraction`, whole-word regex). **Extract the
   shared scoring/term helpers** (`contentTerms`, stopword set, `escapeRegExp`, the
   `minMatch` rule) into a small `src/sources/term-match.ts` module imported by both
   `medrxiv.ts` and `psyarxiv.ts`, rather than copy-pasting. This is a targeted refactor of
   existing duplication, kept minimal.
4. Return top `limit` as `Paper`:
   - `sourceId: 'osf:<guid>'`
   - `sourceKind: 'psyarxiv'`
   - `title`  ← `attributes.title`
   - `abstract` ← `attributes.description`
   - `url: 'https://osf.io/<guid>'`
   - `pubTypes: []`
   - `isPreprint: true`

**Why `osf:<guid>` and not `doi:`:** the OSF guid is always present (the DOI sometimes isn't),
it is stable and unique for the `seen()`/`ProcessedSource` idempotency ledger, and `fullText`
recovers it directly from the prefix. Each source already owns its own id keyspace
(`PMID:`, `doi:`, now `osf:`); the cross-run ledger is keyed per-source-id, not cross-source.

#### `fullText(sourceId): Promise<string | null>`

1. Strip the `osf:` prefix to get the guid.
2. `GET /v2/preprints/<guid>/` → `data.relationships.primary_file.links.related.href` →
   `GET` that file node → `data.links.download`.
3. Download the PDF with the rate limiter, enforcing `maxPdfBytes` (skip → `null` if the
   `Content-Length` or streamed size exceeds the cap) and the request timeout.
4. `parsePdf(bytes)` → text (default impl wraps **`unpdf`**: `extractText` over the loaded
   document, pages joined with `\n`).
5. Trim and **truncate to `maxTextChars`** (a full paper dwarfs an abstract; this protects the
   per-run `tokenBudget`). Return the text, or `null` if empty.
6. **Any error anywhere → `null`** (try/catch), so the agent falls back to the abstract —
   matching the `pubmed.fullText` contract. Log at info level like the medRxiv page-failure path.

The OSF JSON paths (`relationships.primary_file`, `links.download`, `attributes.description`)
will be validated against a recorded live response via a fixtures spec during implementation,
exactly as medRxiv's `*.fixtures.spec.ts` does.

### 2. `term-match.ts` (extracted shared helper)

`src/sources/term-match.ts` exports the stopword set, `contentTerms(query)`,
`escapeRegExp(s)`, and a `scoreRecord`/`minMatch` helper used by both preprint sources.
`medrxiv.ts` is refactored to import these (behavior-preserving; its existing tests must stay
green). `psyarxiv.ts` imports the same. No behavior change to medRxiv scoring.

### 3. `research-agent.ts` — explicit third dep

- `AgentDeps` gains `psyarxiv: MedrxivLike` (same `{ search, fullText }` shape as medrxiv).
- After the medrxiv search, add:
  `const psyPapers = await this.deps.psyarxiv.search(topic, maxPapersPerTopic).catch(... -> [])`.
- Spread into the queue: `...psyPapers.map(p => ({ kind: 'psyarxiv' as const, id: p.sourceId, paper: p }))`.
- Update the `search done` log to include `psyarxiv: psyPapers.length`.
- **Replace the binary full-text branch** with explicit per-kind routing:
  ```
  let full: string | null = null;
  if (paper.sourceKind === 'pubmed')       full = await this.deps.pubmed.fullText(pmid).catch(() => null);
  else if (paper.sourceKind === 'medrxiv') full = await this.deps.medrxiv.fullText(paper.sourceId).catch(() => null);
  else if (paper.sourceKind === 'psyarxiv') full = await this.deps.psyarxiv.fullText(paper.sourceId).catch(() => null);
  ```
  (Today's `else` would wrongly route PsyArXiv papers to `medrxiv.fullText`.)
- Discovery expansion remains PubMed-only (unchanged).

### 4. Types & wiring

- `src/types.ts`: `SourceKind = 'pubmed' | 'medrxiv' | 'psyarxiv'`.
- `research-runner.service.ts` `defaultBuildAgent`: construct `new PsyArxivTool({ token:
  process.env.OSF_TOKEN, log })` and pass `psyarxiv` into the `ResearchAgent` deps.
- `package.json`: add `unpdf` to `dependencies`.
- `.env.example` + `packages/research/README.md`: document the `RESEARCH_PSYARXIV_*` knobs and
  `OSF_TOKEN`.

## Data flow

```
topic
  ├─ pubmed.search   → PMIDs
  ├─ medrxiv.search  → Paper[]  (abstract only)
  └─ psyarxiv.search → Paper[]  (abstract; full-text fetched later)
        → queue → per paper:
             seen? skip
             relevanceGate(abstract)
             [pubmed only] discovery expansion via related()
             fullText:
               pubmed   → BioC JSON
               medrxiv  → null (abstract)
               psyarxiv → OSF PDF → unpdf → truncated text  (null → abstract on failure)
             extract(paper, body) → candidate
             in-run dedup → collect
  → runResearch submits each candidate to bot /admin/strategies/ingest
```

## Error handling & safety

- PsyArXiv records are preprints (`isPreprint: true`), un-peer-reviewed; every candidate still
  passes the relevance gate and lands as a pending `StrategyDraft` for human review (ADR-0012).
- `fullText` is fail-safe: network error, missing primary file, oversized PDF, parse failure,
  or empty text all yield `null` → the agent uses the abstract. A PsyArXiv paper is never
  dropped solely because its PDF couldn't be read.
- `maxPdfBytes` and `maxTextChars` bound memory and token cost. The per-run `tokenBudget` and
  `agentTimeoutMs` remain the global backstops.
- OSF rate limiting honored via `RateLimiter` (default 1000ms) and optional `OSF_TOKEN`.

## Testing (TDD — write specs first)

- `src/sources/__tests__/psyarxiv.spec.ts` — fixture OSF JSON: window paging + dedup by guid +
  `maxRecords` cap; term-scoring keeps/ranks correctly; `Paper` mapping (`osf:` id,
  `psyarxiv` kind, `isPreprint: true`, url/title/abstract).
- `fullText` unit tests (in the same spec or a sibling): mock the
  preprint→file→download fetch chain with an injected `parsePdf` stub — assert
  happy-path text, `maxPdfBytes` skip → `null`, `maxTextChars` truncation, and
  fail-safe → `null` on each failure mode.
- `src/sources/__tests__/psyarxiv.fixtures.spec.ts` — run the real `unpdf` `parsePdf` against
  a small committed PDF fixture, mirroring the existing medRxiv/pubmed fixtures specs.
- `src/sources/__tests__/term-match.spec.ts` — cover the extracted helper; keep existing
  `medrxiv.spec.ts` green to prove the refactor is behavior-preserving.
- `src/agent/__tests__/research-agent.spec.ts` — extend with a `psyarxiv` fake: PsyArXiv
  papers get queued and processed; `psyarxiv.fullText` (not `medrxiv.fullText`) is called for
  `psyarxiv` papers; abstract fallback when `fullText` returns `null`.
- `pnpm -F research test` green; spot-check `pnpm -F research build`.

## Rollout

Single PR off a new branch. No migration, no bot deploy coupling. The worker picks up the new
source on next run; with no `OSF_TOKEN` set it still works at the unauthenticated rate limit.
