# Research prompts are evaluated by per-step offline experiments

The `@wabi/research` agent's prompt quality is measured by **offline experiments run against each LLM step in isolation**, not against the pipeline as a whole. Each of the agent's five LLM steps (`buildConcepts`, `gate`, `extract`, `judge`, `dedup`) is evaluated by calling *its own function* as a Langfuse experiment "task" over a versioned dataset of labeled examples, scored by evaluators (deterministic code where the output is ground-truthable, LLM-as-a-judge where it is open-ended). Datasets are authored as JSONL checked into the repo (the source of truth, PR-reviewable) and mirrored up to Langfuse, which is purely the run surface.

The work is **phased**, cheapest-and-most-ground-truthable first:

| Phase | Step | Why this order | Evaluator |
|---|---|---|---|
| 1 | `gate` | binary, ground-truthable, cheapest, highest leverage — a bad gate poisons everything downstream | deterministic exact-match → accuracy / reject-precision / reject-recall |
| 2 | `judge` | has a faithfulness boolean + 0–1 score, partly deterministic | code (faithfulness) + score-vs-label correlation |
| 3 | `extract` | open-ended generation, no single right answer | LLM-as-a-judge (faithfulness + actionability rubric) |
| 4 | end-to-end | black-box topic→drafts, catches step-interaction bugs | LLM-as-a-judge on final batch |

Each phase gets its own spec → plan → implement cycle. This ADR is the durable *why*; the per-phase *how* lives in `docs/superpowers/specs/`. Phase 1 is specified in `docs/superpowers/specs/2026-06-19-research-prompt-evals-design.md`.

## Why

- **Per-step attribution is the whole point of an eval.** The five steps chain (`gate → extract → merge → judge → dedup`); a bad final draft could originate in any of them. An end-to-end-only eval tells you the output is wrong but not *which prompt* to fix. Calling each step's function directly pins the failure to one prompt. The steps are already isolated, single-purpose functions (ADR-0037), so this costs no new structure.
- **Offline before online.** We need to test a prompt change *before* shipping it, against a fixed set of cases, and compare runs side by side. That is offline experiments over a dataset — the live traces already flowing to Langfuse (ADR-0038) are the *online* half and feed new edge cases back into the dataset, but they cannot gate a change pre-deploy.
- **Ground-truth-first ordering.** The `gate` is binary and cheap, so its eval is deterministic exact-match with real precision/recall — no LLM-judge reliability questions, no rubric debates. Starting there yields a trusted harness (dataset seeding, experiment runner, evaluator wiring) that the subjective steps inherit, instead of debating rubric calibration before any eval exists.
- **Repo-versioned labels.** Ground-truth labels in checked-in JSONL make eval changes show up in diffs and reproduce without UI clicking. The abstract/input text is stored inline, so an eval reproduces even if the upstream source record disappears.

## Considered options

- **End-to-end only** (Phase 4 as Phase 1). Most realistic — scores the actual `StrategyDraft` batch a topic produces. Rejected as the *starting* point: failures can't be attributed to a step, every item runs all five LLM calls (expensive), and the output is open-ended so it needs LLM-as-a-judge from day one. Kept as the final phase, once per-step evals exist to localize whatever it surfaces.
- **Online evaluation only** — LLM-as-a-judge on live production traces, no datasets. Zero authoring cost and already half-wired via ADR-0038. Rejected as the strategy: no ground truth, no pre-deploy gate, can't iterate on a prompt before shipping it. Adopted as the *complement* — online catches edge cases, which become new offline dataset items.
- **Unit-test assertions instead of Langfuse experiments** (hand-rolled `*.spec.ts` over fixtures, like the existing `llm-fixture-run.ts`). Cheaper to start and no external dependency. Rejected as the primary surface: no score trends over time, no side-by-side run comparison, no path to a CI regression gate, and it duplicates machinery Langfuse already provides (datasets, experiments, score analytics). The existing fixture runner remains useful as a smoke check, not as the eval.
- **Build the dataset by cold hand-labeling** vs. **bootstrap + correct.** Bootstrap (run the current model, then human-correct) reaches a usable set fastest; its anchoring risk is mitigated by injecting known hard cases during correction. Cold-labeling is cleaner but slower. Chose bootstrap+correct for Phase 1 (see the spec); later phases may revisit.

## Consequences

- **A reusable eval harness lands with Phase 1** (`packages/research/evals/` JSONL + `scripts/eval-seed.ts` + `scripts/eval-gate.ts`), and Phases 2–4 extend it rather than each inventing their own.
- **CI gating is deferred, deliberately.** A regression gate needs a trusted baseline, and the baseline is the output of running the experiment manually a few times. Each phase ships as a manual `pnpm -F @wabi/research eval:<step>` first; CI wiring (via `langfuse/experiment-action`) is a later, separate decision once baselines exist.
- **The online/offline loop is now explicit.** Live traces (ADR-0038) are expected to surface cases the datasets miss; the convention is to fold those back into the JSONL, so the datasets grow toward a representative set over time.
- **No change to the agent or the bot.** Eval scripts call the step functions directly and resolve providers the same lazy way the worker does (CLAUDE.md "resolve config lazily"); nothing in the production path moves. Submission to the strategy-admin API (ADR-0012/0034) is untouched.
