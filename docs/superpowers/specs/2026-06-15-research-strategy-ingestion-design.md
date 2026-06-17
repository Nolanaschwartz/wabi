# Research-driven strategy ingestion pipeline — design

**Status:** approved design, pre-implementation
**Date:** 2026-06-15
**Branch:** `feat/research-strategy-ingestion`
**Related ADRs:** 0012 (strategy quality gate — this pipeline is the `research-cron` it names, and deliberately *overrides* its auto-publish rule), 0004 (three-store memory / `wabi_strategies`), 0017 (self-hosted embeddings), 0018 (durable jobs), 0019/0020 (always-on, never serverless), 0002 (privacy boundary). New: **ADR-0033** records the pipeline and the ADR-0012 override.

## Problem

The strategy library's *lifecycle* machinery is well-built — trust gate, publish-to-Qdrant, quarantine/demote, hourly reconcile, and the `/admin/strategies` human-review UI all exist and are tested. What is missing is **every entry point that gets strategies into the system.** Today a `StrategyDraft` can only be created by a direct Postgres write or a test fixture. There is no seed library, no submit API, and the `research-cron` / `session-mining` pipelines that ADR-0012 and ARCHITECTURE.md describe are unimplemented.

This spec covers the **research pipeline**: how Wabi autonomously discovers and extracts evidence-based coaching strategies from public biomedical literature and turns them into review-queued drafts. Session-mining and behavioral-applicability matching are explicitly out of scope (see Non-goals).

## Decisions locked during brainstorming

1. **Autonomy:** every researched strategy lands in the human-review queue before it can coach anyone. No auto-publish on this path — a deliberate tightening of ADR-0012 (see §Trust override).
2. **Agenda:** a curated seed topic list **plus** agentic discovery — the agent may branch to related papers, not just walk a fixed list.
3. **Execution:** a separate worker package/process, isolated from the always-on bot. It submits drafts to the bot over an authenticated HTTP endpoint; it never writes Postgres or Qdrant directly.
4. **Sources (v1):** NCBI/PubMed E-utilities + medRxiv. Both keyless, structured, programmatic. Open-web search/fetch ("common practices") is phase 2.
5. **Scope (v1):** prove high-quality, well-grounded *technique* extraction into the queue. No `StrategyDraft` shape change; no behavioral-applicability metadata; no retrieval changes beyond reusing `search` for dedup. One small new model — `ProcessedSource` (a source-ID ledger for cross-run idempotency, §Agent behavior) — is in scope; it is not a `StrategyDraft` change.

### Agent behavior (resolved this round)

The agent is no longer a black box. Five decisions fix how it reads and what it stores:

- **Reading depth — full text when freely available, abstract otherwise.** A coaching *technique* (the usable protocol) lives in a paper's intervention/methods section, not the abstract. The agent reads PubMed Central open-access full text and medRxiv full text when cleanly fetchable, and falls back to the abstract otherwise — returning `null` rather than guessing when the abstract is too thin. Bounded by the existing per-topic timeout and token budget.
- **What we store — grounded, *generalized* technique, not audience-adapted text.** The extractor pulls the transferable, actionable mechanism in audience-neutral language ("tense-and-release the major muscle groups for ~5 min lowers acute anxiety"), keeping the verbatim quote + the studied population as grounding/context. It does **not** rewrite findings into gamer-speak. Gamer framing and Wabi's voice are applied at **coaching time**, where the user's actual state and memory live — pre-baking a framing here would freeze a context-blind guess and, decisively, break `faithfulnessCheck` (an adapted technique has no source text to ground against). The studied-population context captured now is the raw material for the deferred behavioral-applicability spec.
- **Decision policy — deterministic selection + a thin LLM relevance gate.** Search hits are ranked deterministically (E-utilities relevance + publication type, preferring meta-analysis/RCT/review). One cheap LLM call per candidate acts as a relevance gate — "is this a coaching-relevant behavioral technique worth reading/branching from?" — and drives branch-or-stop; all hard caps still bound the loop. The gate runs on the **abstract first**, so full text is fetched only for papers that pass.
- **In-run technique dedup — yes, via the worker's existing LLM (no embeddings in the worker).** At COLLECT, each candidate is checked against candidates already kept this run: a lexical prefilter (normalized title/technique overlap) then an LLM confirm on close calls. Duplicates are dropped *and* the agent prefers to keep reading/branching (within caps) to fill its quota with **distinct** techniques rather than waste a draft slot.
- **Source-level idempotency — a persistent `ProcessedSource` ledger queried via a bot tool.** Before READ, the agent calls an authenticated bot endpoint `GET /admin/strategies/seen?sourceId=…`; if the paper was processed on any prior run it is skipped before any full-text fetch or extraction. The ledger is ID-only (no content, no personal data), **written by the bot** at ingest as a side-effect of `submitDraft` — the worker has no DB access (ADR-0002/0033). A tiny in-memory visited set is kept *within* a run only, to avoid re-calling the tool when `elink` loops back to a paper already touched this run.
  - **Write timing (v1):** record only the three *candidate-producing* terminal outcomes — submitted / library-deduped (`409`) / safety-rejected — all written by the bot at ingest. Gated-out and null-extraction papers (which never reach ingest, so only the worker knows them) are **not** recorded in v1: that would need a second worker-driven write path and would permanently freeze a *first-pass negative* judgment a reviewer never saw, which is wrong while we're still proving extraction quality. Accepted consequence: a re-run still re-reads papers that yielded nothing last time (bounded by the small per-run caps). If that waste bites at volume, v2 adds barren-paper marking *with a gate/extractor version stamp* so improving a prompt re-opens old papers.
- **Inference roles — capable extractor, lighter triage.** `extract` runs on a capable `getProvider('research')` role (quality-critical: faithful, generalized extraction; tunable/swappable independently). `relevanceGate` (the highest-volume call) and `dedup` (a simple same/different judgment, both low-stakes and recoverable) share a **lighter triage role** — reuse the existing classifier-tier model if it fits cleanly, else a new `'research-triage'` role. All on the self-controlled tier (production-inference topology). Guard: the classifier tier is the floor for the gate — if its false-negative rate (silently dropping relevant papers) looks bad in quality eval, bump only that role.

## Non-goals (explicitly deferred)

- **Behavioral-applicability matching** — enriching strategies with grounded "what user state this targets" so retrieval can key off observed tilt/mood/playtime instead of message similarity. This is the eventual point of the "pattern-matching" idea, but it changes the data model and retrieval; it gets its own spec once the library is populated and extraction quality is proven.
- **Open-web sources** ("common practices," forums, non-allowlisted journals) — phase 2, once extraction quality is measurable on clean structured sources.
- **Session-mining** — a separate pipeline (mine coaching gaps from conversations → `session-mined` drafts). Untouched here.
- **Auto-publish** — out of scope by decision (1).

## Architecture

A new isolated worker, `packages/research`, does all heavy/bursty agentic work *outside* the bot. It submits finished candidate drafts to the bot over an authenticated endpoint, so **every write still flows through the existing trust gate** and the bot remains the single writer of the strategy library.

```
packages/research  (new, separate process)
  seed-topics.ts ........ curated list of gamer-wellbeing themes (config)
  sources/
    pubmed.ts ........... NCBI E-utilities: esearch, efetch/esummary, elink (related → discovery), PMC full text
    medrxiv.ts .......... medRxiv details API + full text (preprints; tagged lower-evidence)
  agent/
    research-agent.ts ... bounded loop: search → seen-check → gate → discover → read → extract → dedup → collect
    relevance-gate.ts ... thin LLM call on the abstract; gates full-text read and branch-or-stop
    extract.ts .......... LLM turns one full-text/abstract source into a grounded StrategyDraft candidate
    dedup.ts ............ in-run technique dedup (lexical prefilter → LLM confirm), no embeddings
  bot-client.ts ......... talks to the bot, x-admin-secret auth: submit() + seen()
  run.ts ................ entrypoint: scheduled run + `--topic X` manual run, hard bounds

packages/bot  (existing, minimal additions)
  strategy-admin.controller.ts
    + POST /admin/strategies/ingest  (AdminGuard) → dedup → submitDraft() → record ProcessedSource → pending-review
    + GET  /admin/strategies/seen    (AdminGuard) → ProcessedSource lookup → { seen: bool }
  prisma/schema.prisma
    + model ProcessedSource { sourceId @unique, source, firstSeenAt, lastStatus }  (ID-only ledger)
```

### Units (each one job, injected dependencies, no hidden globals)

1. **`PubMedTool`** — wraps NCBI E-utilities. `search(query)`, `fetch(ids)` (abstract + structured metadata), `fullText(id)` (PMC open-access when available), `related(id)` (`elink`, the agentic-discovery primitive). Pure HTTP, no LLM. Serializes through a rate limiter.
2. **`MedrxivTool`** — wraps the medRxiv details API + full text. Same `search`/`fetch`/`fullText` surface; every result carries `isPreprint: true`.
3. **`relevanceGate`** — one cheap LLM call on a paper's *abstract*: is this a coaching-relevant behavioral technique worth reading/branching from? Returns a keep/skip + a branch hint. Gates the expensive full-text read.
4. **`ResearchAgent`** — the only agentic orchestrator. Given a seed topic: `seen`-check each candidate, deterministically rank, run the relevance gate, branch-or-stop via `related()`, read full text, call `extract`, dedup in-run, collect. Halts at hard bounds; holds an in-memory `RunState` (visited set + counters + tally/stop-reason).
5. **`extract`** — one full-text/abstract source → one candidate draft *or* `null`, storing a **generalized, audience-neutral** technique with a **verbatim** `sourceText` quote grounding it (never gamer-adapted — that is coaching-time work). Returns `null` when the source has no clean, safe, self-contained technique.
6. **`dedup` (in-run)** — given a candidate and the run's kept candidates, returns duplicate/distinct via lexical prefilter then LLM confirm. No embeddings.
7. **`BotClient`** — thin authenticated HTTP client to the bot: `submit(candidate)` and `seen(sourceId)`. The only outbound coupling to the bot.
8. **Bot ingest endpoint** — new authenticated route: library dedup (reuse `strategyRetrieval.search`) → `submitDraft()` → trust gate → record `ProcessedSource`.
9. **Bot seen endpoint** — new authenticated read route: `ProcessedSource` lookup by `sourceId` → `{ seen }`. Source-level idempotency primitive.
10. **`run` entrypoint** — schedules runs, enforces the per-run budget, supports a manual single-topic run for evaluating extraction quality.

### Boundaries this buys

- **Blast radius:** the agent loop and web I/O can never starve the Discord gateway or crisis pipeline — different process (ADR-0019/0020 hold for the bot; the worker is not always-on).
- **Privacy (ADR-0002):** the worker only ever touches *public* data. No access to user data, Redis buffers, or personal memory. Separation by construction.
- **Single-sourced trust:** all safety/faithfulness/dedup logic stays in the bot's trust gate, never duplicated in the worker.

## Data flow

```
run.ts
  └─ load seed topics (config)
  └─ for each topic, within the run budget:
       ResearchAgent.run(topic)         (holds RunState: visited set + counters + tally/stop-reason)
         1. SEARCH    PubMedTool.search(topic) + MedrxivTool.search(topic); rank deterministically
                      (E-utilities relevance + pub-type, preferring meta-analysis/RCT/review)
         2. SEEN      per candidate: BotClient.seen(sourceId) ──HTTP──▶ GET …/seen
                      true (processed any prior run) → skip before any read/extract
         3. GATE      relevanceGate(abstract) → skip off-topic; full text only for papers that pass
         4. DISCOVER  (agentic) PubMedTool.related(keptHit) → adjacent papers; branch-or-stop,
                      bounded by maxDiscoverySteps / maxPapersPerTopic
         5. READ      fullText(id) when freely available, else abstract (+ medRxiv flag)
         6. EXTRACT   extract(source) → candidate | null  (generalized technique, verbatim quote)
                      { title, technique, evidence, sourceText (verbatim), sourceUrl, trustLevel:'research-agent' }
         7. DEDUP     dedup(candidate, kept) → distinct ? keep : drop & prefer reading on for a novel one
         8. COLLECT   accumulate until maxDraftsPerTopic
  └─ for each collected candidate:
       BotClient.submit ──HTTP──▶ POST /admin/strategies/ingest (x-admin-secret)
                                    a. LIB DEDUP: strategyRetrieval.search(title+technique)
                                                  ≥ threshold → 409, skip (logged)
                                    b. submitDraft → trust gate: 'research-agent' ⇒ QUEUE
                                                   → Postgres row status='pending-review'
                                    c. record ProcessedSource(sourceId) on submit / 409 / safety-reject
                                       (candidate-producing outcomes only; single writer = bot)
  └─ write run summary: searched / gated-out / source-seen-skipped / extracted /
                        in-run-deduped / submitted / lib-deduped / rejected / stop-reason
```

The existing human path is unchanged: operator opens `/admin/strategies`, reviews pending drafts, approves/rejects.

**Three load-bearing choices:**
- **Dedup is layered, cheapest-first.** (a) *Source seen* — a bot lookup against the `ProcessedSource` ledger short-circuits a paper we've processed on any prior run, before any read/extract. (b) *In-run technique* — the worker's LLM drops same-technique candidates within a run (no embeddings in the worker). (c) *Library technique* — the bot's embedding search rejects near-duplicates of the published library at ingest (`409`, counted, never silently dropped). Embeddings live only on the bot; the worker stays embedding-free.
- **The agent extracts a *generalized* technique; the bot vets; the coach adapts.** The worker's extraction LLM produces a context-neutral *candidate* grounded in a verbatim quote. The bot's existing `safetyFilter` + `faithfulnessCheck` (verifies `sourceText` supports the technique) are the authority — the worker never asserts safe/faithful. Audience adaptation (gamer voice, the user's live state) happens later, at coaching time — never at ingestion.
- **The bot is the single writer of every store, including the new ledger.** The worker has no DB credentials; it reaches the ledger only through the authenticated `seen`/`ingest` endpoints. This keeps ADR-0002's privacy boundary and ADR-0033's single-writer rule intact even as we add cross-run state.

## Bounds & budget

Every dimension of the autonomous loop is hard-capped. Configurable, conservative defaults:

| Bound | Default | Why |
|---|---|---|
| `maxTopicsPerRun` | 5 | Caps a run's total work; predictable cost. |
| `maxPapersPerTopic` | 8 | Limits READ/EXTRACT fan-out per topic. |
| `maxDiscoverySteps` | 2 | How far the agent may branch via `related()`. The only unbounded-by-nature dimension, so the tightest. |
| `maxDraftsPerTopic` | 3 | One topic can't flood the queue. |
| `maxDraftsPerRun` | 10 | Protects the human reviewer — the real bottleneck. The most conservative number here on purpose. |
| `agentTimeoutMs` (per topic) | 90s | Wall-clock kill switch for a stuck loop. |
| `runTimeoutMs` | 10min | Whole-run ceiling. |

Plus:
- **NCBI rate limit:** 3 req/s without a key, 10 with one. Tools serialize through a small limiter so a run can't get the IP blocked. Optional `NCBI_API_KEY` raises the ceiling.
- **Token budget per run:** a hard output-token ceiling; on hit, the run finishes the current candidate and stops, logging what it skipped (no silent truncation).
- **Idempotency:** dedup-at-ingest means re-running the same topics is a near-no-op (everything `409`s).
- **Fail-open-empty:** any tool/LLM failure aborts *that candidate only*, counted in the summary; a run never crashes the worker and a bad source can't poison the batch.

## Provenance, evidence & the trust override

**Evidence level is assigned by the worker, verified by the human.** Each candidate's `evidence` string is set from the source's nature — never the LLM's self-claim (ADR-0012):

| Source | Evidence tag |
|---|---|
| PubMed — systematic review / meta-analysis / RCT | `"peer-reviewed: <study type>"` (read from E-utilities publication-type metadata) |
| PubMed — observational / other | `"peer-reviewed: observational"` |
| medRxiv | `"preprint: not peer-reviewed"` (always flagged) |

The reviewer sees this in `/admin/strategies` and can edit it via the existing `POST /admin/strategies/:id/evidence`.

**The ADR-0012 override (the one deliberate deviation).** ADR-0012: allowlisted source + safety + faithfulness → *auto-publish*. `ncbi.nlm.nih.gov` is allowlisted, so by the letter of the trust gate a PubMed draft passing both checks would publish with no human. Decision (1) overrides this: **research-pipeline drafts always queue.** Implementation: research drafts carry `trustLevel: 'research-agent'` (alongside `allowlisted | community | session-mined`); the trust gate routes `research-agent` to **queue unconditionally** — the same one-line treatment it already gives `session-mined`. Safety + faithfulness still run (a reviewer never sees something that failed them), but their result can only gate-to-queue, never auto-publish. Recorded in **ADR-0033** because it intentionally contradicts ADR-0012, and ADRs win where docs disagree — the contradiction belongs on the record, not buried in code.

**Faithfulness grounding** is why `extract` must return a *verbatim* quote, not a paraphrase: the bot's `faithfulnessCheck` asks "does this source text support this technique?" A paraphrase would let the extractor's own hallucination grade its homework. Verbatim-only is enforced in extraction and asserted in tests.

## Test plan (TDD, repo norm)

**Worker unit tests (`packages/research`), mocked HTTP/LLM:**
- `PubMedTool` — `search`/`fetch`/`fullText`/`related` parse real-shaped E-utilities + PMC fixtures; `fullText` returns `null` cleanly for non-open-access; rate limiter serializes; HTTP error throws cleanly.
- `MedrxivTool` — parses fixtures; `fullText` resolves preprint body; every result `isPreprint: true`.
- `relevanceGate` — on-topic abstract → keep; off-topic abstract → skip (full text never fetched); asserts the gate runs on abstract *before* any `fullText` call.
- `extract` — fixture full text → candidate whose `sourceText` is an **actual substring** of the input (assert substring, not paraphrase) and whose technique is **audience-neutral** (asserts no gamer-specific tokens injected); vague/unsafe source → `null`; preprint input → `"preprint…"` evidence tag; thin abstract-only source with no protocol → `null` (prefers null over guessing).
- `dedup` — two candidates of the same technique → second is `duplicate`; distinct techniques → `distinct`; lexical prefilter short-circuits before the LLM confirm on obvious cases.
- `ResearchAgent` — respects every bound (`maxPapersPerTopic`, `maxDraftsPerTopic`, `maxDiscoverySteps`, per-topic timeout); a `seen=true` paper is skipped before read/extract; an in-run duplicate is dropped and the agent reads on for a novel one (within caps); the in-memory visited set prevents an `elink` loop from re-calling `seen`; a tool failure drops one candidate and the run continues; `RunState` stop-reason is set.
- `BotClient` — `submit` sends `x-admin-secret`, maps `409`→lib-deduped / `2xx`→submitted / other→error; `seen` maps `{seen:true}`→skip.
- `run` — honors `maxDraftsPerRun` and token budget across topics; emits the full searched / gated-out / source-seen-skipped / extracted / in-run-deduped / submitted / lib-deduped / rejected / stop-reason summary.

**Bot-side tests (`packages/bot`):**
- `strategy-admin.controller.spec.ts` — new `POST /admin/strategies/ingest`: rejects without `x-admin-secret`; near-duplicate → `409`; novel → calls `submitDraft`, records `ProcessedSource`, returns draft id. New `GET /admin/strategies/seen`: rejects without secret; known `sourceId` → `{seen:true}`; unknown → `{seen:false}`.
- `strategy-trust-gate.spec.ts` — **new guarded case:** `trustLevel: 'research-agent'` routes to `queue` even when source is allowlisted and both checks pass (the ADR-0012 override; named so the deviation can't silently regress).
- Library dedup unit — candidate above similarity threshold vs a seeded point → `409`; below → proceeds.
- `ProcessedSource` — ingest records the `sourceId`; a second ingest of the same `sourceId` finds it via `seen`.

**Integration (testcontainers, existing pattern):**
- Real Qdrant + Postgres: seed one published strategy, submit a near-duplicate via ingest → lib-deduped; submit a novel candidate → lands `pending-review` in Postgres, records a `ProcessedSource` row, and is **not** yet retrievable (queued, not published); a follow-up `seen(sourceId)` returns `true`. Reuses `strategy-retrieval.integration.ts` harness.

The testability seam: the worker is pure functions + injected tool/LLM/HTTP clients; the bot side reuses already-covered machinery. The only genuinely new bot logic is dedup + the `research-agent` trust branch, both small and directly tested.

## Open implementation questions (for the plan, not blocking)

- Exact medRxiv query strategy (its API is date-window/cursor based, not a free-text search like E-utilities — may need an esearch-style filter on returned metadata, or a narrower date window per run).
- Full-text fetch/parse path: PMC open-access via E-utilities (BioC/XML) vs the OA service; how to detect "freely available" cleanly; size cap before extraction so a huge body can't blow the token budget.
- Whether the triage role reuses the existing classifier-tier model or introduces a dedicated `'research-triage'` provider entry (resolved in design that it *is* a lighter shared role; only the wiring detail remains).
- Worker scheduling mechanism (its own cron in-process vs invoked by an external scheduler) — decision (3) only fixes that it is a *separate process*.
