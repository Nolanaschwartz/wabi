# Documentation Accuracy & Concision Pass — Design

**Date:** 2026-06-16
**Status:** Approved (design)

## Goal

Make every documentation claim match the current code, and tighten verbose prose
and filler comments. Two qualities, in priority order:

1. **Accuracy** — docs/ADRs/READMEs/comments that contradict the code (wrong ports,
   renamed modules, dead references, stale flows) are corrected to match reality.
2. **Concision** — verbose prose is trimmed; comments that merely restate the code
   are removed or sharpened. No content/meaning changes beyond tightening.

Explicit non-goals: no restructuring, no reformatting passes, no file deletion, no
unrelated refactoring of docs structure or navigation.

## Scope

**In scope**
- Top-level docs: `README.md`, `AGENTS.md`, `CLAUDE.md`, `CONTEXT-MAP.md`,
  `docs/ARCHITECTURE.md`, `docs/PLAN.md`, `docs/downtime-alerting.md`,
  `docs/contexts/*/CONTEXT.md`, `docs/agents/*.md`
- ADRs: `docs/adr/*.md` (35 files) — **accuracy-only** (see ADR rule below)
- Package READMEs: `packages/{bot,web,shared,research}/README.md` and the two
  nested READMEs under `packages/research`
- Code comments: inline + JSDoc across all 4 packages (`packages/*/src/**`)

**Out of scope (historical / ephemeral — do not audit or edit)**
- `.scratch/*` — local markdown issue tracker, ephemeral by design
- `docs/superpowers/plans/*`, `docs/superpowers/specs/*` — point-in-time artifacts
- `docs/agent-architecture.html` — generated visualization
- Generated files, `node_modules`

## ADR rule

ADRs are a historical record of decisions. This pass may **only** correct factual
drift inside them — wrong file paths, renamed modules/services, dead references,
out-of-date code snippets. It must **never** rewrite the decision, rationale, or
narrative. If an ADR appears wholesale wrong (the decision itself no longer
reflects reality), it is **flagged in the findings** for human attention, not
auto-edited.

## Architecture: two-phase pipeline

### Phase 1 — read-only audit (parallel subagents)

No edits in this phase. Work is partitioned by surface and fanned out:

| Agent | Surface |
|-------|---------|
| docs-top | Top-level docs (README, AGENTS, CLAUDE, CONTEXT-MAP, ARCHITECTURE, PLAN, downtime-alerting, contexts/*, agents/*) |
| adr-1 | ADRs 0001–0017 |
| adr-2 | ADRs 0018–0035 |
| readmes | All package READMEs |
| comments-bot | `packages/bot/src/**` comments |
| comments-web | `packages/web/**` comments |
| comments-shared | `packages/shared/src/**` comments |
| comments-research | `packages/research/src/**` comments |

(`comments-bot` may sub-split if the package proves too large for one agent's
context.)

Each agent must use the graphify graph (`graphify query/explain/path`) plus
targeted reads to verify claims against current code — not memory. Each returns a
structured findings list and makes **no edits**.

**Findings schema (per item):**
```
{
  file:        string   // path
  location:    string   // line range, heading, or symbol
  category:    "staleness" | "concision"
  severity:    "high" | "medium" | "low"
  claim:       string   // what the doc/comment currently says
  reality:     string   // what the code actually does (staleness only)
  proposed_fix: string  // concrete replacement text or "delete"
  adr_flag?:   boolean  // true = wholesale-wrong ADR, needs human, do not auto-edit
}
```

The orchestrator merges all agent outputs into one findings document:
`docs/superpowers/specs/2026-06-16-doc-cleanup-audit.md`, grouped by surface.

### Approval gate

User reviews findings **per surface** (one group at a time): approve / reject /
amend individual items within each group. Only approved items proceed.

### Phase 2 — apply approved fixes

- Apply approved fixes surface by surface.
- One atomic commit per surface (e.g. `docs: fix drift in package READMEs`,
  `docs: tighten bot code comments`). Cite the relevant ADR in the commit when a
  fix is shaped by one, per repo convention.
- ADR items: only `adr_flag === false` items are applied; flagged ones are left
  for the user.
- Sanity checks after edits: `pnpm build` / typecheck (JSDoc edits can affect
  typedoc/type inference), and `pnpm test` if any change touches a doc that tests
  assert against.

## Error handling & edge cases

- **Subagent returns nothing / dies** — orchestrator records the gap and re-dispatches
  that surface rather than silently skipping it. No silent coverage loss.
- **Ambiguous claim (can't verify against code)** — record as a finding with
  `reality: "unverifiable"` and low severity; surface it rather than guessing.
- **Comment edit would break code** — comment-only edits should be inert, but
  JSDoc/typedoc-affecting changes are caught by the post-edit typecheck; revert any
  that break the build.
- **Concision vs meaning** — when trimming risks dropping real information, prefer
  keeping the information; flag as `low` rather than over-cutting.

## Testing / verification

- Phase 1 produces no code changes — verification is the user's per-surface review.
- Phase 2: `pnpm build` and `pnpm test` after each surface's edits; before/after
  the commit, confirm the build is green.

## Deliverables

1. `docs/superpowers/specs/2026-06-16-doc-cleanup-design.md` (this file)
2. `docs/superpowers/specs/2026-06-16-doc-cleanup-audit.md` (phase-1 findings)
3. A series of atomic commits applying approved fixes (phase 2)
