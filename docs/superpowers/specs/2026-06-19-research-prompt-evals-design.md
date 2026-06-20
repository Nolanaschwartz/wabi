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

---

## Phase 1 — `gate` eval (full design)

### Files

```
packages/research/evals/
  gate.dataset.jsonl        # labeled examples — checked in, source of truth, PR-reviewable
packages/research/scripts/
  eval-bootstrap.ts         # pull real abstracts + current-model labels -> seed the JSONL
  eval-seed.ts              # JSONL -> Langfuse dataset (idempotent upsert)
  eval-gate.ts              # pull dataset -> runExperiment -> print summary + run URL
```

### Dataset: bootstrap + human correction

Ground truth is the only part needing human judgment. Process:

1. **`eval-bootstrap.ts`** pulls ~50 real abstracts across a few representative topics using the existing source adapters (PubMed esearch/esummary, Europe PMC), runs the *current* `gate` over each, and writes them to `gate.dataset.jsonl` with the model's label and `reviewed: false`.
2. **Human correction pass:** flip wrong labels, set `reviewed: true`. During this pass, deliberately add known hard cases (sports-psychology, clinical-only, child-study, epidemiology-only abstracts) so the set isn't anchored solely to topics the current model already handles. Bootstrap anchoring is the known risk; the hard-case injection is the mitigation.
3. The original model label is retained in metadata so we can later measure how far human correction diverged from the model (a cheap signal of current gate quality).

JSONL item schema (one per line):

```json
{
  "input": { "abstract": "..." },
  "expectedOutput": "keep",
  "metadata": { "source": "pubmed", "id": "PMID...", "topic": "sleep", "modelLabel": "keep", "reviewed": true }
}
```

`input` / `expectedOutput` map directly onto Langfuse dataset-item fields; `metadata` carries provenance + the original model label.

### Task function

`relevanceGate(abstract)` takes no provider arg — `generate('research-triage', …)` resolves the provider lazily inside it (CLAUDE.md "resolve config lazily"). It returns `{ keep: boolean }`.

```ts
const task: ExperimentTask = async (item) => {
  const { keep } = await relevanceGate(item.input.abstract);
  return keep; // boolean
};
```

No pipeline, no network beyond the single LLM call. Temp is already 0 in the gate prompt.

### Evaluators (deterministic code — no LLM-judge in Phase 1)

- **Item-level:** `correct = output === (item.expectedOutput === 'keep')` → boolean score per item. (Dataset stores human-readable `"keep"/"reject"` labels; the task returns a boolean, so the evaluator maps.)
- **Run-level:** `accuracy`, `reject_precision`, `reject_recall`. The gate fails open, so its two failure modes have asymmetric cost — a false-keep wastes downstream tokens (extract+judge run on junk), a false-reject silently drops a good paper. Tracking precision/recall on the `reject` class makes both visible; accuracy alone would hide them.

### Run surface

`pnpm -F @wabi/research eval:gate` (new package script → `ts-node scripts/eval-gate.ts`). Mirrors `llm-fixture-run.ts`: loads root `.env` lazily, resolves the `research-triage` provider, pulls the `research-gate` dataset from Langfuse, runs the experiment, prints accuracy/precision/recall and the Langfuse run URL.

**Manual run only in Phase 1.** CI gating is deferred — a regression gate needs a trusted baseline first, and the baseline is the output of running this manually a few times.

### Repo vs. Langfuse

Labels live in versioned JSONL (diffs visible in PRs, no UI clicking to reproduce). `eval-seed.ts` mirrors them up to a Langfuse dataset, which is purely the *run surface*. Re-seeding is idempotent (upsert by item id).

### Out of scope (Phase 1)

LLM-as-a-judge; CI gating; the other 4 steps; prompt changes (this phase *measures*, it doesn't tune — tuning comes once we have a baseline).

## Open questions / risks

- **Bootstrap anchoring** — mitigated by the hard-case injection in the human-correction pass (above). If correction flips very few labels, that itself is suspect and worth a cold-label spot check.
- **Dataset drift** — real abstracts may go stale or unavailable; the JSONL stores the abstract text inline, so the eval is reproducible without re-fetching.
- **Provider cost** — ~50 items × temp-0 gate calls per run is cheap; safe to run on every prompt edit by hand.
