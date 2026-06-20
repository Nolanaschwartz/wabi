# Research agent prompt evals — design

**Date:** 2026-06-19
**Status:** Phase 1 designed; Phases 2–4 sketched
**ADR:** [0040 — Research prompts are evaluated by per-step offline experiments](../../adr/0040-research-prompts-are-evaluated-by-per-step-offline-experiments.md) (the durable *why* + roadmap; this spec is the Phase 1 *how*)
**Scope:** Offline, repeatable prompt evals for the `@wabi/research` agent's LLM steps. Phase 1 (the `gate` step) is specified in full; later phases get their own spec → plan cycle.

## Background

The research agent (`packages/research/src/agent/`) makes 5 LLM calls per run, each an isolated function:

| Step | Fn (file) | Provider | Output shape |
|---|---|---|---|
| `buildConcepts` | concept query builder | research | vocab terms |
| `gate` | `relevanceGate(abstract)` in `relevance-gate.ts` | research-triage (CLASSIFIER) | `{ keep: boolean }` (fails open → `keep: true`) |
| `extract` | `extract-with-lenses.ts` | research (COACH) | `[{title, technique, sourceText}]` |
| `judge` | `judge.ts` | research (COACH) | `{faithful, score, title, technique, rationale}` |
| `dedup` | `dedup.ts` | research-triage (CLASSIFIER) | same/different |

All 5 are already Langfuse-instrumented via the ADR-0038 OTEL tracer. There is an existing real-LLM harness pattern at `scripts/llm-fixture-run.ts` (loads root `.env` lazily, resolves providers, mocks `fetch` to serve fixtures).

## Goal

Replace guesswork about prompt quality with repeatable offline experiments. Start with the cheapest, most ground-truthable step and build a reusable harness the later steps inherit.

## Approach (decided)

**Per-step offline experiments via the Langfuse TS SDK.** Each step's function is the experiment "task"; a Langfuse Dataset of labeled examples drives it; evaluators score output vs. expected. This pinpoints *which prompt* regressed (vs. end-to-end, which can't attribute failures) and is cheap + CI-gateable later.

End-to-end eval (Phase 4) is the *final* phase, not the first.

## Phased roadmap

| Phase | Step | Order rationale | Evaluator |
|---|---|---|---|
| **1** | `gate` | binary, ground-truthable, cheapest, highest leverage (a bad gate poisons everything downstream) | deterministic exact-match → accuracy / reject-precision / reject-recall |
| 2 | `judge` | has a faithfulness boolean + 0–1 score, partly deterministic | code (faithfulness exact-match) + score-vs-label correlation |
| 3 | `extract` | open-ended generation, no single right answer | LLM-as-a-judge (faithfulness + actionability rubric) |
| 4 | end-to-end | black-box topic→drafts, catches step-interaction bugs | LLM-as-a-judge on final batch |

Each phase = its own spec → plan → implement. This doc details **Phase 1 only**.

## Decisions (grilled 2026-06-19)

The branches resolved before planning. Each is reflected in the Phase 1 sections below.

| # | Decision | Why |
|---|---|---|
| 1 | **Harness lives in `@wabi/research`**; `@langfuse/client` becomes a direct dep of research. Nothing eval-specific in `@wabi/shared`. | Eval is research-context *policy*, not a shared kernel (ADR-0037). Shared stays the *tracing* kernel. |
| 2 | **Prompt-under-test = code, not Langfuse prompt management.** Each experiment run is named/tagged with the **git SHA**; compare versions in the Langfuse run-comparison view. | Git already versions prompts; adopting prompt management would put a remote prompt fetch on the always-on worker's hot path just to run evals. Defer to a separate ADR if iteration velocity ever demands it. |
| 3 | **First run measures eval trustworthiness, not just the gate.** N=3 repeats per item on the first run; report `flip_rate` + `empty_reply_rate` as first-class run metrics, then settle on N. | The gate calls a *reasoning* model that (per project memory) ignores tiny token caps and can return empty → fails open to `keep`. Determinism is assumed by the code comment but unproven; measure it before trusting any single number. |
| 4 | **Balanced two-pronged dataset** (~60 items, ~50/50). Positives + deliberately-harvested negatives. Hand-written adversarial cases (was "C") **deferred** for speed. | The gate only ever sees abstracts that matched a wellness query, so a naive pull is ~all keeps and the reject metrics would be statistical noise — yet over-leniency is the gate's most likely real failure. |
| 5 | **Ground truth = an independent intent rubric** (`evals/LABELING.md`), *not* the gate prompt's wording. Cross-phase principle (recorded in ADR-0040). | The user does not trust the current gate policy. Labeling by the prompt would only measure instruction-following and would score a wrong policy as 100%. Intent-based labels survive every prompt edit and are what lets the eval *drive* improvement. |
| 6 | **Separate Langfuse project for evals** (own key pair in env). | Keeps production score analytics / the online↔offline boundary (ADR-0038/0040) free of synthetic eval traces. |
| 7 | **Positives harvested through the real concept-query path** (`topicToConcepts` → render → `search` → `hydrate`); **negatives through direct probe queries**. | Positives must match the production distribution the gate actually sees; negatives must deliberately reach *outside* it to surface the four reject categories. The asymmetry is intentional. |

---

## Phase 1 — `gate` eval (full design)

Sources are standalone-callable (`new PubMedTool({ fetchFn, minIntervalMs })` → `search(query, limit)` → `hydrate(paper)`), confirmed against `llm-fixture-run.ts`. The gate (`relevanceGate`) imports only `generate` + config, so it runs outside the agent/runner entirely.

### Files

```
packages/research/evals/
  gate.dataset.jsonl        # labeled examples — checked in, source of truth, PR-reviewable
  LABELING.md               # the intent rubric = ground truth (decision #5); user-owned
packages/research/scripts/
  eval-bootstrap.ts         # harvest abstracts + current-model labels -> seed the JSONL
  eval-seed.ts              # JSONL -> Langfuse (eval project) dataset (idempotent upsert)
  eval-gate.ts              # pull dataset -> runExperiment -> print summary + run URL
```

`@wabi/research/package.json` gains `@langfuse/client` (decision #1) and an `eval:gate` script. `.env.example` gains the eval-project key pair (decision #6), resolved lazily like everything else.

### Ground truth: the intent rubric (decision #5)

`evals/LABELING.md` is a short, prompt-agnostic paragraph stating what *should* be kept: an adult could self-apply this for mood / stress / rumination / sleep / focus / motivation / social-anxiety in daily life. It is **not** derived from the gate prompt — the prompt is the thing under test and the two are allowed to disagree. The human labels against this rubric; that disagreement is the signal that drives prompt iteration. The user owns and finalizes this file.

### Dataset: two-pronged harvest + human correction (decisions #4, #7)

1. **`eval-bootstrap.ts`** holds a fixed list of *positive topics* and *negative-probe queries* (so the dataset is reproducible from one command), and:
   - **Positives** — for each positive topic, run the real search path: `topicToConcepts(topic)` → render per-source query → `search` → `hydrate`. These match the production distribution the gate sees.
   - **Negatives** — run each negative-probe query (e.g. "athletic performance anxiety", "SSRI depression treatment trial", "parenting intervention child anxiety", "prevalence depression cohort") via direct keyword `search` → `hydrate`, deliberately reaching outside the production distribution to surface the four reject categories.
   - Run the *current* gate over every harvested abstract, write to `gate.dataset.jsonl` with the model's label and `reviewed: false`. Target ~60 items, ~50/50.
2. **Human correction pass:** label each item against `LABELING.md` (decision #5), flip wrong labels, set `reviewed: true`.
3. The model's original label is retained in `metadata.modelLabel` — the divergence between it and the corrected label is the first cheap read on current gate quality (the user does not trust the gate, decision #5).

JSONL item schema (one per line):

```json
{
  "input": { "abstract": "..." },
  "expectedOutput": "keep",
  "metadata": { "source": "pubmed", "id": "PMID...", "topic": "sleep", "bucket": "positive", "modelLabel": "keep", "reviewed": true }
}
```

`input` / `expectedOutput` map onto Langfuse dataset-item fields; `metadata.bucket` (`positive`/`negative`) records the two-pronged provenance for coverage checks. The abstract text is stored inline, so the dataset is frozen and reproducible even after live source records change.

### Task function (decision #2)

`relevanceGate(abstract)` takes no provider arg — `generate('research-triage', …)` resolves the provider lazily inside it (CLAUDE.md "resolve config lazily"). It returns `{ keep: boolean }`. The prompt under test is whatever is committed; the experiment run is named with the git SHA.

```ts
const task: ExperimentTask = async (item) => {
  const { keep } = await relevanceGate(item.input.abstract);
  return keep; // boolean
};
```

No pipeline, no network beyond the single LLM call.

### Evaluators (deterministic code — no LLM-judge in Phase 1) (decision #3)

- **Item-level:** `correct = output === (item.expectedOutput === 'keep')` → boolean score per item. (Dataset stores human-readable `"keep"/"reject"` labels; the task returns a boolean, so the evaluator maps.)
- **Run-level:**
  - `accuracy`, `reject_precision`, `reject_recall` — the gate fails open, so its two failure modes have asymmetric cost (false-keep wastes downstream tokens; false-reject silently drops a good paper). Reject-class precision/recall makes both visible; accuracy alone would hide them. A balanced dataset (#4) makes these real fractions.
  - `flip_rate` — fraction of items whose verdict was *not* unanimous across the run's N repeats. The first run uses **N=3** to learn whether this model is actually deterministic here; if ~0, drop to N=1 for routine runs.
  - `empty_reply_rate` — fraction of calls returning empty/starved text (which fail open to `keep`). Surfaces how much "keep accuracy" is real keeps vs. fail-open masking.

An empty reply counts as `keep` in `accuracy` (production-faithful — that's what the worker does) *and* is counted in `empty_reply_rate`, so the masking is always visible alongside the headline number.

### Run surface (decisions #2, #6)

`pnpm -F @wabi/research eval:gate` (new package script → `ts-node scripts/eval-gate.ts`). Mirrors `llm-fixture-run.ts`: loads root `.env` lazily, resolves the `research-triage` provider, authenticates to the **eval Langfuse project** (separate key pair), pulls the `research-gate` dataset, runs the experiment named with the current git SHA, prints accuracy/reject-precision/reject-recall/flip-rate/empty-reply-rate and the Langfuse run URL.

**Manual run only in Phase 1.** CI gating is deferred — a regression gate needs a trusted baseline first, and the baseline is the output of running this manually a few times.

### Repo vs. Langfuse

Labels live in versioned JSONL (diffs visible in PRs, no UI clicking to reproduce). `eval-seed.ts` mirrors them up to the eval-project dataset, which is purely the *run surface*. Re-seeding is idempotent (upsert by item id).

### Out of scope (Phase 1)

LLM-as-a-judge; CI gating; the other 4 steps; hand-written adversarial cases (deferred, decision #4); prompt changes (this phase *measures*; tuning comes once we have a baseline — though decision #5 means the very first measurement is already an audit of the untrusted gate).

## Open questions / risks

- **Bootstrap anchoring** — the model's labels seed the dataset; mitigated because the human corrects against an *independent* rubric (#5), not the model. Divergence (`modelLabel` vs corrected) is itself the first quality signal.
- **Reasoning-model non-determinism** — the central risk; #3's `flip_rate`/`empty_reply_rate` turn it from an assumption into a measured number on run one.
- **Dataset drift** — abstracts stored inline, so the dataset is frozen and reproducible without re-fetching.
- **Provider cost** — ~60 items × N gate calls is cheap; safe to run on every prompt edit by hand.
