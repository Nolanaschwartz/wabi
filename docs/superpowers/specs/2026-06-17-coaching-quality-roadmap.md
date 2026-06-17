# Coaching Quality Roadmap

**Date:** 2026-06-17
**Status:** Approved (umbrella roadmap; each phase gets its own spec → plan → implementation cycle)
**Theme:** Deepen the core loop — specifically *coaching quality*, the actual back-and-forth between a user and Wabi.

## Why this, why now

The chosen north star is **deepening the core loop** rather than adding surface area. Within that loop, the weakest link is **coaching quality**: how natural, attuned, and genuinely helpful the conversation feels.

### What the coach is today

Reading `packages/bot/src/modules/coaching/` (`coach-handler.ts`, `coach-prompt.ts`, `coach.service.ts`):

- **Single static persona.** `buildCoachPrompt` uses one fixed `SYSTEM_DEFAULT` string, swapped only for the aftermath variant. Same voice and stance for every user, every turn.
- **Single-shot generation.** `CoachService.generateDetailed` makes one `generateText` call (plus an empty-response retry). No agentic loop — the coach cannot decide to ask a clarifying question, recall a *specific* memory, or take an action mid-turn.
- **Retrieved context is dumped, not reasoned over.** Strategies and memories are concatenated into the prompt ("Relevant strategies: …") and the model is trusted to use them well. The coach never selects which strategy fits, or decides that none do.
- **No coaching-quality measurement.** The only recorded scores are operational — `latency_sla` and `reply_present` (`recordScores` in `coach-handler.ts`). Nothing measures whether a reply was *good coaching*.

### The strategic crux

The last point governs the sequencing. **We cannot reliably deepen coaching quality without measuring it.** Every improvement below is otherwise a guess validated by vibe. ADR-0014 already establishes an eval store, so the foundation exists — Phase 1 builds on it.

## The deepening ladder

| # | Lever | What it adds | Differentiation | Risk |
|---|---|---|---|---|
| 1 | **Coaching evals** | LLM-judge scores coaching-quality dimensions on traces; baseline number before any coach change | Meta-enabler — de-risks everything below | Low; no hot-path change |
| 2 | **Adaptive stance** | Per-turn mode: listen/validate vs reflect vs nudge/challenge vs offer-strategy | High — the "knows when to push vs listen" axis | Med; prompt + selection step |
| 3 | **Strategy reasoning** | Coach selects + weaves the best-fit strategy (or none) instead of dumping all | Med — makes "evidence-based" feel real | Med |

**Sequencing: 1 → 2 → 3.** Measurement first because it grounds the rest; adaptive stance next because it is the single biggest "it gets me" lever for the least architectural disruption; strategy reasoning third.

## Phases

### Phase 1 — Coaching evals *(enabler)*

LLM-judge scores coaching-quality dimensions on existing Langfuse traces:
- **Empathy / attunement** — did the reply meet the person where they are?
- **Strategy-use appropriateness** — was a strategy applied, and did it fit?
- **Safety adherence** — did it respect the crisis/aftermath boundaries (ADR-0021)?
- **Helpfulness** — did the turn actually advance the person, not just respond?

Lands an eval dataset + scoring so we have a baseline before touching the coach. No hot-path change.

**Done when:** every coach turn receives quality scores, and an aggregate coaching-quality number is visible and trendable in Langfuse.

### Phase 2 — Adaptive stance *(biggest felt win)*

Replace the single static persona with per-turn stance selection — *listen/validate*, *reflect*, *nudge/challenge*, or *offer-strategy* — chosen from the user's current state and message. Prompt shaping in `buildCoachPrompt` reflects the selected stance. Validated against the Phase-1 evals.

**Done when:** stance is selected per turn, the prompt reflects it, and eval scores (especially attunement) improve over the Phase-1 baseline.

### Phase 3 — Strategy reasoning

The coach selects and weaves the single best-fit retrieved strategy (or explicitly none) rather than dumping all retrieved strategies into context.

**Done when:** strategy-use eval scores improve and irrelevant-strategy intrusions drop.

## Parked — earn their place later

These are deliberately *not* in this roadmap. They are strong ideas held back until evidence justifies them.

- **Follow-through** — track commitments the user made and circle back ("you said you'd stop after 2 losses — how'd it go?"). Very high stickiness, but it edges into proactivity (Wabi initiating), which is a different axis than coaching quality. Candidate for the *next* roadmap.
- **Agentic coach** — tool use mid-turn (recall a specific memory, log mood, set a follow-up). Biggest rearchitecture; the single `generateText` call becomes a small agent loop. Only pursued if Phases 2–3 show the single-shot ceiling is real. Earns its place by evidence, not enthusiasm.

## How we work it

This document is the umbrella. It is **too much for one spec.** Each phase gets its own full cycle: brainstorm → design spec → implementation plan → TDD implementation, per the project's working conventions (`CLAUDE.md`). Phases ship behind their ADR citations where a structural decision is involved.

**Immediate next step:** brainstorm **Phase 1 (coaching evals)** into a design spec.
