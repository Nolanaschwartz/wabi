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
5. **Scope (v1):** prove high-quality, well-grounded *technique* extraction into the queue. No `StrategyDraft` shape change; no behavioral-applicability metadata; no retrieval changes beyond reusing `search` for dedup.

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
    pubmed.ts ........... NCBI E-utilities: esearch, efetch/esummary, elink (related → discovery)
    medrxiv.ts .......... medRxiv details API (preprints; tagged lower-evidence)
  agent/
    research-agent.ts ... bounded tool-calling loop (search → discover → read)
    extract.ts .......... LLM turns one source into a grounded StrategyDraft candidate
  ingest-client.ts ...... POSTs candidates to the bot, x-admin-secret auth
  run.ts ................ entrypoint: scheduled run + `--topic X` manual run, hard bounds

packages/bot  (existing, minimal additions)
  strategy-admin.controller.ts
    + POST /admin/strategies/ingest  (AdminGuard) → dedup → submitDraft() → trust gate → pending-review
```

### Units (each one job, injected dependencies, no hidden globals)

1. **`PubMedTool`** — wraps NCBI E-utilities. `search(query)`, `fetch(ids)`, `related(id)` (`elink`, the agentic-discovery primitive). Pure HTTP, no LLM. Serializes through a rate limiter.
2. **`MedrxivTool`** — wraps the medRxiv details API. Same `search`/`fetch` surface; every result carries `isPreprint: true`.
3. **`ResearchAgent`** — the only agentic unit. Given a seed topic, calls the tools, decides branch-or-stop, halts at hard bounds. Returns candidate drafts.
4. **`extract`** — one source record → one candidate draft *or* `null`, with a **verbatim** `sourceText` quote grounding the technique. Returns `null` when the source has no clean, safe, self-contained technique.
5. **`IngestClient`** — thin HTTP client to the bot's ingest endpoint; the only outbound coupling to the bot.
6. **Bot ingest endpoint** — new authenticated route: dedup (reuse `strategyRetrieval.search` against the live library) → existing `submitDraft()` → trust gate.
7. **`run` entrypoint** — schedules runs, enforces the per-run budget, supports a manual single-topic run for evaluating extraction quality.

### Boundaries this buys

- **Blast radius:** the agent loop and web I/O can never starve the Discord gateway or crisis pipeline — different process (ADR-0019/0020 hold for the bot; the worker is not always-on).
- **Privacy (ADR-0002):** the worker only ever touches *public* data. No access to user data, Redis buffers, or personal memory. Separation by construction.
- **Single-sourced trust:** all safety/faithfulness/dedup logic stays in the bot's trust gate, never duplicated in the worker.

## Data flow

```
run.ts
  └─ load seed topics (config)
  └─ for each topic, within the run budget:
       ResearchAgent.run(topic)
         1. SEARCH    PubMedTool.search(topic) + MedrxivTool.search(topic) → candidate papers
         2. DISCOVER  (agentic) PubMedTool.related(bestHit) → adjacent papers; branch-or-stop,
                      bounded by maxDiscoverySteps / maxPapersPerTopic
         3. READ      fetch abstract (+ medRxiv flag) per chosen paper
         4. EXTRACT   extract(source) → candidate | null
                      { title, technique, evidence, sourceText (verbatim), sourceUrl, trustLevel:'research-agent' }
         5. COLLECT   accumulate until maxDraftsPerTopic
  └─ for each candidate:
       IngestClient.submit ──HTTP──▶ POST /admin/strategies/ingest (x-admin-secret)
                                       a. DEDUP: strategyRetrieval.search(title+technique)
                                                 ≥ threshold → 409, skip (logged)
                                       b. submitDraft → trust gate: 'research-agent' ⇒ QUEUE
                                                      → Postgres row status='pending-review'
  └─ write run summary: searched / extracted / submitted / deduped / rejected
```

The existing human path is unchanged: operator opens `/admin/strategies`, reviews pending drafts, approves/rejects.

**Two load-bearing choices:**
- **Dedup lives at the ingest boundary, not in the worker.** The bot owns the embeddings and live library, so it is the only place that can reliably answer "do we already have this?" The worker stays stateless. A near-duplicate returns `409` and is counted in the summary, never silently dropped.
- **The agent extracts; the bot vets.** The worker's extraction LLM produces a *candidate*. The bot's existing `safetyFilter` + `faithfulnessCheck` (verifies `sourceText` supports the technique) are the authority — the worker never asserts a strategy is safe or faithful.

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
- `PubMedTool` — `search`/`fetch`/`related` parse real-shaped E-utilities fixtures; rate limiter serializes; HTTP error throws cleanly.
- `MedrxivTool` — parses fixtures; every result `isPreprint: true`.
- `extract` — fixture abstract → candidate whose `sourceText` is an **actual substring** of the input (assert substring, not paraphrase); vague/unsafe abstract → `null`; preprint input → `"preprint…"` evidence tag.
- `ResearchAgent` — respects every bound (`maxPapersPerTopic`, `maxDraftsPerTopic`, `maxDiscoverySteps`, per-topic timeout); a tool failure drops one candidate and the run continues.
- `IngestClient` — sends `x-admin-secret`; maps `409`→deduped, `2xx`→submitted, other→error in the summary.
- `run` — honors `maxDraftsPerRun` and token budget across topics; emits the searched/extracted/submitted/deduped/rejected summary.

**Bot-side tests (`packages/bot`):**
- `strategy-admin.controller.spec.ts` — new `POST /admin/strategies/ingest`: rejects without `x-admin-secret`; near-duplicate → `409`; novel → calls `submitDraft`, returns draft id.
- `strategy-trust-gate.spec.ts` — **new guarded case:** `trustLevel: 'research-agent'` routes to `queue` even when source is allowlisted and both checks pass (the ADR-0012 override; named so the deviation can't silently regress).
- Dedup unit — candidate above similarity threshold vs a seeded point → `409`; below → proceeds.

**Integration (testcontainers, existing pattern):**
- Real Qdrant + Postgres: seed one published strategy, submit a near-duplicate via ingest → deduped; submit a novel candidate → lands `pending-review` in Postgres and is **not** yet retrievable (queued, not published). Reuses `strategy-retrieval.integration.ts` harness.

The testability seam: the worker is pure functions + injected tool/LLM/HTTP clients; the bot side reuses already-covered machinery. The only genuinely new bot logic is dedup + the `research-agent` trust branch, both small and directly tested.

## Open implementation questions (for the plan, not blocking)

- Exact medRxiv query strategy (its API is date-window/cursor based, not a free-text search like E-utilities — may need an esearch-style filter on returned metadata, or a narrower date window per run).
- Which `getProvider` role the extractor uses (new `'research'` role vs reuse an existing one) — keep extraction on the self-controlled tier per the production inference topology.
- Worker scheduling mechanism (its own cron in-process vs invoked by an external scheduler) — decision (3) only fixes that it is a *separate process*.
