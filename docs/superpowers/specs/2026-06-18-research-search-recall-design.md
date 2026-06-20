# Research search recall — design

**Status:** approved design (grilled 2026-06-19), pre-implementation
**Date:** 2026-06-18 (revised 2026-06-19)
**Branch:** TBD (`feat/research-search-recall`)
**Related ADRs:** 0036 (Source interface — EPMC/OSF are new adapters behind it; the windowed-fetch *tactic* it used for preprints is what this reverses), 0034 (research worker), 0033/0012 (trust-gate ingest + `ProcessedSource`), 0009 (stores). New: **ADR-0039** (preprint sources use server-side topical search).

## Problem

The pipeline extracts good, on-topic strategies, but recall is capped two ways and the preprint path also **hangs**:

- **PubMed** sends the raw topic verbatim to `esearch`, so spaces become an implicit `AND` (`tilt emotion regulation competitive gaming` → 5-way AND → ~1 hit), with `retmax≈10`, no relevance sort, no pagination. History is reachable; the query strangles it. And the literature's vocabulary differs from the user's — **no paper contains "tilt"** — so even an OR of the raw terms misses the mechanism ("frustration/anger regulation under competitive stress").
- **Preprints** are not topic-searched at all. `WindowedPreprintSource` paginates a **60-day, 1500-record window** per source through a **1s/page rate limiter** (~16 medRxiv pages + ~15 PsyArXiv pages), then filters locally. Every older preprint is invisible, and the bulk fetch **hangs the run ~30–90s before any LLM call** — on topic 1 it exhausts the 90s per-topic `agentTimeoutMs` (the deadline starts before the search phase), producing the observed `agentTimeout tokens=0`.

## Decisions (locked during the grill, 2026-06-19)

1. **Binding constraint is latency (the pre-LLM hang), not token cost.** Cost was already addressed (negative cache + the now-superseded IDF). The pipeline is *timing out*, i.e. losing collection.
2. **Re-attribute the per-topic timeout** — start the `agentTimeoutMs` deadline *after* the search phase. Search is bounded by `runTimeoutMs` (600s) and the source caps; it must not consume per-topic LLM-processing budget. (Issue `00`, shippable independently and first.)
3. **Structural topical-search migration**, not a rate-limit band-aid. The windowed bulk-fetch was a choice, not a necessity — both preprint APIs support server-side topical search. Replacing it collapses the hang, the historical-recall ceiling, and the IDF local-filter into one fix.
4. **Keep `PubMedTool` (E-utilities); migrate only the preprint sources.** PubMed doesn't hang; `elink` citation-graph discovery (`expand()`) is PubMed-only and load-bearing (ADR-0033); PubMed recall is fixed cheaply by the query builder. Cost accepted: two query-construction paths instead of one.
5. **Keep both preprint corpora, both via topical search:** Europe PMC `SRC:PPR` (medRxiv + bioRxiv) and OSF `filter[q]` (PsyArXiv — EPMC's PsyArXiv coverage is partial, so it keeps its own source). The dementia flood was a *windowed + generic-term* artifact; a topical query won't reproduce it, so medRxiv earns its keep.
6. **Pure source-layer swap.** The downstream per-paper pipeline (`gate → extract-with-lenses → merge → judge → dedup`), trust-gate ingest, and the **negative cache** (`ProcessedSource`/`markGated`) are untouched. The lens fan-out improvements (①/② from the prior discussion) remain independently valid and are sequenced *after* this migration.
7. **Query builder = LLM rewrite → neutral concept set + per-source adapters + deterministic fallback.** One `research-triage` call per topic (~5/run) maps the topic to `{ core: [mechanism phrases + synonyms], context: [domain terms] }` — the gaming→literature vocabulary bridge, the real recall unlock. Pure per-source adapters render the concept set into each API's syntax. Fallback on LLM empty/error (fail-open): deterministic OR-of-`contentTerms` + quoted bigrams per source (fixes the AND-collapse without synonym expansion).

## What dies

`WindowedPreprintSource` (core + window cache) and **`term-match.ts` in its entirety** — `contentTerms`, `minMatch`, `scoreRecord`, and the `idf`/`weightedScore` committed 2026-06-19 (`85780cd0f`). Topical search ranks server-side; there is no local corpus to weight. The windowed source specs go with them. The IDF commit was the correct fix for the windowed design that existed that morning; topical search supersedes the design. Removed wholesale in the migration (issue `05`), as one coherent commit — not retro-dropped from the current branch.

## Architecture (after)

```
sources/
  pubmed.ts ............ UNCHANGED (E-utilities; elink discovery; PMC/EPMC OA full text)
  query/
    concepts.ts ........ LLM topic → {core, context} concept set (+ deterministic fallback)
    pubmed-adapter.ts ... concepts → E-utilities term
    epmc-adapter.ts ..... concepts → Europe PMC query (SRC:PPR scope)
    osf-adapter.ts ...... concepts → OSF filter[q] string
  europepmc.ts ......... NEW Source: topical SRC:PPR search across history (medRxiv/bioRxiv)
  psyarxiv.ts .......... REWORKED Source: OSF filter[q] topical search (replaces windowed)
  windowed-preprint-source.ts, term-match.ts ... DELETED
```

Result breadth: reuse `RESEARCH_SEARCH_LIMIT` (~40) per source, server-ranked by relevance (EPMC `cursorMark`, OSF `links.next`; single page likely enough). Cross-source dedup: keyspaces are mostly disjoint (`PMID:`/`doi:`/`osf:`) — the existing in-run `visited` set + `ProcessedSource` cover it; no new mechanism. Evidence tier: EPMC `SRC:PPR` and OSF → preprint tier (as medRxiv today); `floorForTier` unchanged.

## Phasing

- **`00` — timeout re-attribution.** One-liner + test. Ships first, independent of the migration; stops topic-1 from timing out immediately.
- **`01`–`02` — query builder + per-source adapters.** The vocabulary bridge; also fixes PubMed's AND-collapse in place.
- **`03`–`04` — Europe PMC + OSF topical sources.**
- **`05` — wire EPMC/OSF into the runner, delete the windowed layer, cross-source dedup, tier mapping.**
- **(later) lens fan-out ①/②** — separate feature, sequenced after.

## Risks

- **Cost** — broader queries ⇒ more gate calls. Bounded by `RESEARCH_SEARCH_LIMIT`, the cheap negative-cached gate, the unchanged `maxPapersPerTopic`. Log fetched/gated/processed; no silent truncation.
- **OSF `filter[q]` strength** — verify it does usable full-text search over preprint title/abstract before relying on it; if weak, PsyArXiv falls back to EPMC's partial coverage or stays windowed *in isolation* (would not reintroduce the medRxiv hang).
- **EPMC syntax** — confirm `SRC:PPR` + field tags + `cursorMark` against the live REST docs; do not implement from memory.
- **Precision** — synonym-expanded queries bring looser hits; gate v2 + judge are the backstop.

## Open questions

None blocking. Implementation-time verifications only (OSF `filter[q]`, EPMC field syntax — above).
