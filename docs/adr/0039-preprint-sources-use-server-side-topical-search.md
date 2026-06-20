# Preprint sources use server-side topical search

The medRxiv and PsyArXiv evidence sources stop fetching a recency **window** and filtering it locally. Instead they issue a **server-side topical query** per topic and take back the server's top-ranked results: medRxiv/bioRxiv via **Europe PMC** (`SRC:PPR`), PsyArXiv via **OSF `filter[q]`**. The query for every source — including PubMed — is built from an LLM-derived **concept set** (`{ core: mechanism phrases + synonyms, context: domain terms }`) rendered by a pure per-source adapter, with a deterministic `contentTerms`-based fallback when the LLM is unavailable. `WindowedPreprintSource`, the shared window cache, and all of `term-match.ts` (`contentTerms`/`minMatch`/`scoreRecord` and the `idf`/`weightedScore` added the same week) are deleted. `PubMedTool` (E-utilities) is **kept** — it does not window, and its `elink` citation-graph discovery (ADR-0033) has no Europe PMC equivalent we want to rebuild.

This sits *on top of* ADR-0036 (the `Source` interface): Europe PMC and the reworked OSF source are two new adapters behind the same `search`/`hydrate`/`fullText` contract. What it reverses is the **windowed-fetch tactic** ADR-0036's preprint adapters happened to use — not the interface.

## Why

- **The window fetch hung the run and timed out the first topic.** Each preprint source paginated a 60-day / 1500-record window through a 1s/page rate limiter (~16 medRxiv + ~15 PsyArXiv pages) on the first topic that touched it, *before* any LLM call. With the per-topic `agentTimeoutMs` clock already running, topic 1 consistently exhausted its 90s budget during the fetch and exited with `agentTimeout tokens=0`. (The timeout is also re-attributed to start after the search phase — necessary but not sufficient; the fetch still hangs the run ~30–90s.)
- **The window could not reach history.** Anything older than 60 days, or beyond the first 1500 records, was invisible by construction — the opposite of what an evidence miner wants. Topical search reaches the whole corpus and lets the server rank.
- **The user's vocabulary is not the literature's.** No paper contains "tilt"; the mechanism is "frustration/anger regulation under competitive stress." A windowed local term-match (even IDF-weighted) can only match words that are literally present. The LLM concept rewrite bridges gaming language → clinical/psychology language, which is where most of the missing recall actually was.
- **IDF was the right fix for the design that existed, and is now moot.** IDF-weighting fixed the windowed local filter's "a generic term floods the window" failure. Server-side topical search has no local corpus to weight, so the entire term-match layer — IDF included — has nothing to do. Recorded here so a future reader doesn't puzzle over code that was added and removed within days: it was correct for the windowed era, superseded by this decision.

## Considered options

- **Band-aid the rate limit** (1000 → ~400ms/page). ~2.5× faster hang, zero recall or history gain, and throwaway once topical search lands. Rejected — it preserves the design we're removing.
- **Unify everything into one Europe PMC source** (`SRC:MED` + `SRC:PPR`), retiring `PubMedTool` too. Simplest topology and trivial cross-source dedup, but it discards `elink` citation-graph discovery (PubMed-only, load-bearing per ADR-0033) and rewrites a working, fast source for no hang/recall benefit (PubMed never windowed). Rejected — keep `PubMedTool`, accept two query-construction paths.
- **Drop medRxiv** (it produced the "dementia flood"). Rejected — that flood was a *windowed + generic-term* artifact, not medRxiv being off-domain; a topical query won't reproduce it, and medRxiv has already yielded a usable technique. Both corpora kept.
- **Deterministic-only query builder** (no LLM). Cheaper (no extra calls) but can't bridge vocabulary, leaving most recall on the table for exactly the gaming-context topics. Kept only as the fail-open fallback.

## Consequences

- **Pure source-layer change.** The downstream pipeline (`gate → extract-with-lenses → merge → judge → dedup`), the trust-gate ingest, and the `ProcessedSource` negative cache are untouched. Lens fan-out improvements remain a separate, later effort.
- **Two query syntaxes to maintain** (E-utilities vs Europe PMC vs OSF), isolated in pure, unit-tested per-source adapters fed by one shared concept set.
- **Cross-source dedup stays as-is.** `PMID:`/`doi:`/`osf:` keyspaces are largely disjoint; the in-run `visited` set + `ProcessedSource` handle collisions. No new mechanism.
- **Two live-API assumptions to verify at implementation** (not from memory): OSF `filter[q]` does usable full-text search over preprint title/abstract; Europe PMC `SRC:PPR` + field-tag + `cursorMark` syntax. If OSF `filter[q]` is weak, PsyArXiv may fall back to EPMC's partial coverage or stay windowed *in isolation* — which would not reintroduce the medRxiv hang.
