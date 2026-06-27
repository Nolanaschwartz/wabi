# Research agent tooling — design

**Date:** 2026-06-26
**Status:** Proposed
**Package:** `@wabi/research` (with two `@wabi/shared/generate`-module additions: a sibling
`generateObject`, and lifting `embed` into a `@wabi/shared/embed` subpath)

## Goal

Make each step of the research extraction pipeline more **reliable**, **faster**, and **higher
recall/quality** — without surrendering the properties that make the worker safe to run always-on:
predictable cost, static per-step fail-policy, step-level testability, and the ADR-0033/0034 trust
boundary (the worker never touches user/strategy stores; it submits candidates over HTTP and a human
reviews them, ADR-0012).

## Decision: deterministic skeleton, agentic muscle in one bounded pocket

The pipeline is a fixed DAG (`search → interleave → per-paper: prescreen → gate → expand → fullText →
extract → merge → judge → dedup → submit`). The control flow is data-dependent in a way you *cannot*
enumerate in exactly one place: **discovery/expansion** ("which citations of this paper are worth
chasing?"). Everywhere else every paper walks the same path, so a DAG is strictly better — cheaper,
parallel, testable, with fail-policy that sits beside the code (ADR-0021).

Therefore:

- **Keep the DAG as the control plane.** Budgets, deadlines, fail-policy, parallelism, the safety
  boundary stay deterministic.
- **Carve out discovery as a bounded agentic sub-routine.** The model decides *which* neighbors to
  chase; the loop itself (queue + `maxDiscoverySteps` counter) stays deterministic. Output is just
  more papers entering the same DAG, so the non-determinism cannot escape the pocket.
- **The reliability/speed levers (structured output, batch judge, embeddings) deepen the DAG** —
  they are not agentic and compose with the skeleton.

Explicitly rejected: a full agentic rewrite (orchestrator LLM + tools looping per paper). It trades
budget predictability, static fail-policy, and step-level eval (ADR-0040) for peak per-paper quality
the human review queue already supplies. Also rejected: in-step RAG over a single paper body —
`MAX_TEXT_CHARS=50000` (~12k tokens) fits in context; the body *is* the context.

## Step 0 (gate) — verify guided-JSON support

Before any Tier-1 work, confirm the self-hosted inference server honors OpenAI
`response_format: {type: "json_schema", …}` (vLLM / llama.cpp / Ollama can; behavior varies by
build). `curl` the `research` and `research-triage` endpoints with a trivial schema.

- **Pass** → Tier 1 uses constrained decoding (the real reliability win).
- **Fail** → Tier 1 degrades to prompt-and-parse (no win); skip it, keep the current hand-rolled
  parse, and proceed to Tier 2 / embeddings / discovery pocket, which do not depend on it.

Record the result in this file before implementing Tier 1.

**Step 0: PASS (2026-06-26)** — `qwopus-3.6-27B-mtp:latest` on the llama-swap/llama.cpp endpoint
(`192.168.1.229:11435`) honored `response_format: {type: json_schema, strict: true}`, returning a
valid schema-conforming object. Tier 1 (Tasks 9–10 / issues 8–9) is unblocked.

## Tier 1 — structured-output seam

**Problem.** `gate`, `extract`, `merge`, `judge` each hand-roll the same fragile ladder:
`stripFences → JSON.parse → shape-check → fail-open`. On a chatty reasoning model any prose, fence
quirk, or starved (empty) reply silently drops the whole step's output.

**Change.**

1. **`@wabi/shared/generate`** — add a **sibling** `generateObject(role, opts & { schema })` export
   (NOT an overload of `generate`). It reuses the same lazy provider resolution, usage summing, and
   telemetry helpers, but keeps `generate`'s text-in/text-out contract pristine — no caller handles a
   maybe-present `.object`. Routes to the AI SDK's `generateObject`. Transport errors still throw; an
   empty/invalid object is a returned value (`object: undefined`), never an exception — fail policy
   stays with the caller. Research must call this, never hand-roll `createOpenAI` + `getProvider` (that
   duplicates the load-order foot-gun ADR-0037 centralizes). Amends ADR-0037 scope (scope-note, no new
   ADR).
2. **`makeResearchGenerate`** — gains a parallel `genObject` variant that calls `generateObject` and
   emits the same span; the text `gen` is unchanged.
3. **Step adoption** — `gate` (constrained `{keep: boolean}` or a yes/no enum), `extract`
   (`{techniques: [...]}`), `merge` (`{groups: number[][]}`), `judge` (see Tier 2). Each step keeps
   its existing fail-open value when `object` is absent. **The verbatim-substring hallucination guard
   in `extract` stays** — a schema constrains shape, not truthfulness; `body.includes(sourceText)` is
   still the only thing that proves a quote is real.

**Benefit.** Removes the silent-drop class across four steps at once; reduces empty-output retries.

## Tier 2 — batch `judge`

**Problem.** `judgeCandidates` (`judge.ts`) fires N independent calls (`Promise.all`, one per
candidate). Against a single local model these serialize, and cost N× tokens.

**Change.** One call per paper judging all candidates → an array
(`{verdicts: [{faithful, scopeOk, score, title, technique, rationale}]}`, indexed to input order;
schema'd if Step 0 passed, else hand-parsed). Keep the per-tier floor/cap and the "sourceText never
rewritten" invariant.

- **Per-index fail-open** (preserves today's per-candidate granularity): parse the array index by
  index. A present, well-formed verdict applies; a missing / short / malformed index falls open to a
  neutral `0.5` *individually* — a whole-batch parse failure does NOT collapse every candidate, only
  the ones actually absent. Count the single call's usage even on a parse miss (today's rule).
- **Cap scales with candidate count.** The batched output is N verdicts, so `maxOutputTokens` must
  scale with N (plus the reasoning model's hidden-reasoning headroom — the cap foot-gun in `config.ts`),
  or a large paper's verdicts truncate and the tail indices needlessly fail open.

**Benefit.** N→1 round-trips against a serializing local model (Ollama, per-model), modest token
saving. Composes with Tier 1.

## Tier 3 — in-run embedding dedup

**Cross-run dedup is out of scope — the bot already owns it.** `StrategyAdminService.ingestBatch`
runs cosine similarity against the strategy library on every ingested candidate (`dedupThreshold()`,
raw-cosine path, ADR-0012) and returns `'deduped'`, which the worker already counts (`bot-client.ts`
→ `run.ts`). A pre-submit `similarStrategy` check would only save a round-trip for candidates that
would be deduped anyway — the submit *is* the check. No new bot endpoint, no `BotClient.similarStrategy`.

**Problem (what the bot does NOT cover).** *In-run* dedup (`dedup.ts`) collapses duplicates *within a
single run* before submit — the bot dedups each candidate against the library, not against its batch
siblings, so two identical new techniques from one run both become drafts without this. Today's in-run
dedup uses a lexical jaccard band + an LLM call for the ambiguous middle, and misses paraphrases the
synonym map doesn't fold (documented known trade).

**Change.**

1. **Lift `embed()` into `@wabi/shared/embed`** (a subpath sibling of `generate`), ported from the
   bot's private `StrategyRetrievalService.embed` (OpenAI-compatible `/v1/embeddings`, role
   `embedding`, lazy provider, omit Bearer when keyless). The bot may migrate to it later (out of
   scope here).
2. **In-run dedup** — embed each candidate's signature once and compare by cosine over the run's
   kept-set vectors (in-memory; no store). Single threshold: `≥ DUP` → duplicate, `< DUP` → distinct.
   The ambiguous-band LLM call is **removed** — the embedding is the semantic judgment the LLM was
   approximating.
   - **Embed `"${title}: ${technique}"`** — the exact string the bot's index/dedup query is built
     from (`StrategyAdminService.isDuplicate` / `publishToQdrant`), so the worker's in-run cosine
     scale matches the bot's library-dedup scale.
   - **Reuse `RESEARCH_DEDUP_THRESHOLD` (default 0.95)** as `DUP` — one knob governs both the worker's
     in-run dedup and the bot's library dedup. The high value is deliberate: in-run dedup is **lossy**
     (a duplicate is dropped, never reaches the human queue), so the safe direction is high — let
     near-paraphrase pairs through to human review (recoverable) rather than risk dropping a genuinely
     distinct technique (unrecoverable). Net change vs today: the old `0.18–0.6` jaccard LLM band's
     pairs now flow to human review instead of being LLM-merged — more drafts to review, no wrongful
     drops, and the dedup LLM call is gone.
   - **Fail-open:** an empty embedding (`[]`, the documented degraded mode) falls back to the existing
     lexical jaccard path, so dedup never hard-depends on the embedder being up.

**Benefit.** Catches same-run paraphrases the lexical filter drops (recall), removes the in-run dedup
LLM call (speed), and unifies the dedup metric with the bot.

## Discovery pocket (the bounded agentic sub-routine)

**Problem.** `expand` returns a flat list of PubMed elink "neighbor" PMIDs (often 30–60), all mapped
to thin papers and all pushed onto the queue, gated only by `maxDiscoverySteps` (a per-topic *trigger*
budget, not a per-expansion *result* cap). Every neighbor then costs a hydrate + prescreen + gate-LLM
call. Zero selectivity.

**Change.** Keep the loop deterministic (the queue + `maxDiscoverySteps` counter — chased papers
re-enter and may themselves trigger expansion). Replace "push all neighbors" with a **deterministic
relatedness cap + topic-aware selector** (layered — the cap is also the selector's fail-open floor):

```
expand(paper) → neighbor IDs (PubMed relatedness-ranked, unchanged)
  → take top maxNeighborsConsidered          deterministic cap: bounds the flood (some papers
                                              have 100+ neighbors) AND bounds summarize/selector input
  → Source.summarize(those ids): ONE batch esummary call → {id, title}[]   (new source method)
  → selector LLM (research-triage, Tier-1 schema if available, else hand-parse):
        in:  { topic, sourcePaper: {title, abstract}, neighbors: [{i, title}] }
        out: { chase: number[] }   (≤ maxChasePerExpansion indices)
  → push the chosen thin papers onto the queue → same hydrate→gate→… DAG
```

- **Bounds:** keep `maxDiscoverySteps`; add `maxNeighborsConsidered` (default ~15, the relatedness
  prefilter) and `maxChasePerExpansion` (default 3, the selector's output cap).
- **Why layered, not either-or:** PubMed neighbors are ranked by similarity to the *paper*, not the
  *run topic*; the selector adds the topic-awareness the ranking lacks. The deterministic cap bounds
  cost (summarize over ~15, not ~100) and the worst case.
- **Fail-open floor:** selector error / empty / unparseable / out-of-range indices → chase the
  deterministic top-`maxChasePerExpansion` of the relatedness-capped list (NOT "chase nothing") — you
  always get some topically-plausible discovery even when the LLM step fails. (Today's behaviour is
  the cruder `expand().catch(() => [])`.)
- **Net cheaper than today:** ~15 considered → ~3 chased *replaces* N (30–100) gate+hydrate calls on
  unranked neighbors.
- **Budget-aware:** the selector's tokens count toward `this.tokens` like every step; and when
  remaining budget `< tokenBudget * budgetPressureFraction`, the whole expansion (summarize + selector)
  is **skipped** — discovery is a bonus, starved first when the run is nearly out of budget.
- **Contained:** output is queue entries only; same budget caps, same fail policy, same ADR-0012 gate.

`// ponytail: one-shot title-only selector; multi-turn fetch-abstracts-on-demand loop only if
title-only selection proves too coarse.` Multi-turn agentic discovery is explicitly out of scope.

## Bounds / config additions

Add to `Bounds` (`types.ts`) + the `ResearchConfig` seed defaults (`config.ts`), editable from
`/admin/research` like the other bounds:

- `maxNeighborsConsidered` (default 15) — deterministic relatedness prefilter before the selector.
- `maxChasePerExpansion` (default 3) — discovery selector output cap (and the deterministic fail-open
  floor when the selector fails).
- `budgetPressureFraction` (default 0.2) — **promoted from the hardcoded `BUDGET_PRESSURE_FRACTION`
  const in `research-agent.ts` to an operator lever.** When remaining budget `< tokenBudget *
  budgetPressureFraction`, the agent both collapses to one lens (existing behaviour) **and skips
  discovery expansion entirely** (new). One knob governs how aggressively a near-exhausted run sheds
  optional work.

In-run dedup reuses the **existing** `RESEARCH_DEDUP_THRESHOLD` env knob (default 0.95) — shared with
the bot's library dedup, no new var. The lexical fallback's `LOW`/`HIGH` jaccard bounds stay as code
constants in `dedup.ts` (model-coupled tuning, only used when the embedder is down).

No new provider env vars: `research` / `research-triage` / `embedding` roles already exist
(`provider.ts`).

## Fail-policy (unchanged philosophy — ADR-0021)

| Step | Failure | Result |
|---|---|---|
| gate | transport / empty / no object | keep (fail-open) |
| extract | transport / empty / invalid object | `[]` |
| merge | transport / invalid groups | keep lexical clusters |
| judge | transport / short array | neutral 0.5 per missing verdict |
| in-run dedup | empty embedding | fall back to lexical jaccard |
| discovery selector | error / empty / bad indices | chase deterministic top-`maxChasePerExpansion` of the relatedness-capped list |

## Testing

- **Step 0:** a recorded `curl` result in this doc; no code test.
- **Tier 1:** extend `generate.spec` for the `schema` branch (object returned; invalid → `object`
  undefined, no throw). Each adopting step's existing fake-`gen` test gains an "object present" and an
  "object absent → fail-open" case.
- **Tier 2:** `judge.spec` — one batched call scores all candidates; short array → neutral fallback;
  cap/floor preserved.
- **Tier 3:** `embed` unit test (shape + keyless header + `[]` on error). `dedup.spec` — cosine
  duplicate/distinct; empty-embedding → lexical fallback.
- **Discovery:** `research-agent.spec` — neighbors capped to `maxNeighborsConsidered`; selector picks
  a subset; only chosen papers enqueued; `maxChasePerExpansion` honored; selector failure → falls back
  to deterministic top-`maxChasePerExpansion` (not zero); under budget pressure → expansion skipped
  entirely (no summarize, no selector). `Source.summarize` fixture test (one batch esummary call for
  many ids), only `pubmed` implements it.
- Per-step offline evals (ADR-0040) updated where prompts change (gate/extract/judge); a **new
  selector eval dataset** built alongside `gate.dataset.jsonl`.
- `budgetPressureFraction` lever: `config.spec` / `run-bounds` validation + seed default.

## Out of scope

- Tier 4: MeSH / controlled-vocabulary lookup for `buildConcepts` (own spec).
- Migrating the bot's private `embed()` to the shared seam (opportunistic cleanup, not required).
- Multi-turn agentic discovery; any agentic control over gate/extract/judge/dedup/submit.

## Sequencing

Tier 1 is **non-blocking**: nothing else hard-depends on it. Tier 2 (batch judge) and the discovery
selector ship with the existing hand-parse pattern (`stripFences → JSON.parse → shape-check →
fail-open`); they *adopt* the schema seam only if Step 0 passes. So a failed/blocked Step 0 blocks
nothing — it only leaves those steps hand-parsing, as they do today. Tiers 2/3 and discovery are
independent and reorderable.

1. Step 0 capability check (record result). Does not gate the rest.
2. Tier 2 batch judge (hand-parse; schema if Step 0 passed).
3. Tier 3 embeddings (shared `embed` → in-run dedup, cosine).
4. Discovery pocket (`Source.summarize` → selector; hand-parse, schema if available).
5. Tier 1 schema seam + retrofit gate/extract/merge/judge — applied across the board once Step 0
   confirms guided JSON; reliability layer, last because it is the only externally-gated piece.

## ADR touchpoints

ADR-0021 (fail-open mining), ADR-0012 (human review gate + library dedup — already owns cross-run, so
the worker only does in-run), ADR-0033/0034 (worker trust boundary), ADR-0036 (Source interface —
`summarize` is a new optional method), ADR-0037 (`generate` deep module — the `schema` addition),
ADR-0040 (per-step offline evals).
