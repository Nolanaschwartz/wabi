# Documentation Accuracy & Concision Pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct every stale documentation/comment claim against current code and tighten verbose prose across all docs, ADRs, READMEs, and code comments — via a read-only audit, per-surface human approval, then applied fixes.

**Architecture:** Two phases. Phase 1 fans out read-only audit subagents (one per surface) that cross-check claims against code using the graphify graph + targeted reads and return structured findings — no edits. The orchestrator merges findings into one audit doc; the user approves per surface. Phase 2 applies only approved fixes, one atomic commit per surface, with build/test sanity checks.

**Tech Stack:** Markdown docs; TypeScript monorepo (pnpm workspace, 4 packages); graphify knowledge graph (`graphify-out/`); NestJS bot, Next.js web.

## Global Constraints

- **Accuracy first, concision second.** Fix contradictions with code; trim verbose prose and comments that restate code. No meaning changes beyond tightening.
- **No restructuring, no file deletion, no unrelated refactoring.** Edit content in place.
- **ADRs are accuracy-only.** Fix factual drift (paths, renamed modules, dead refs, stale snippets) ONLY. Never rewrite a decision/rationale/narrative. Wholesale-wrong ADRs get `adr_flag: true` and are left for the user — not auto-edited.
- **Verify against code, not memory.** Audit agents must use `graphify query/explain/path` + targeted reads.
- **Out of scope (do not touch):** `.scratch/*`, `docs/superpowers/plans/*`, `docs/superpowers/specs/*`, `docs/agent-architecture.html`, generated files, `node_modules`.
- **Findings schema (verbatim):** `{ file, location, category: "staleness"|"concision", severity: "high"|"medium"|"low", claim, reality, proposed_fix, adr_flag? }`.
- Cite the relevant ADR in commit messages when a fix is shaped by one (repo convention). End commits with the Co-Authored-By trailer.

---

## Phase 1 — Read-only audit

### Task 1: Dispatch parallel audit subagents

**Files:**
- Read-only across all in-scope surfaces. No edits.

**Interfaces:**
- Produces: 8 structured findings lists (one per agent), each an array of findings objects matching the Global Constraints schema.

The 8 agents and their surfaces:

| Agent label | Surface |
|-------------|---------|
| `audit:docs-top` | `README.md`, `AGENTS.md`, `CLAUDE.md`, `CONTEXT-MAP.md`, `docs/ARCHITECTURE.md`, `docs/PLAN.md`, `docs/downtime-alerting.md`, `docs/contexts/*/CONTEXT.md`, `docs/agents/*.md` |
| `audit:adr-1` | `docs/adr/0001`–`0017` |
| `audit:adr-2` | `docs/adr/0018`–`0035` |
| `audit:readmes` | `packages/{bot,web,shared,research}/README.md` + `packages/research/**/README.md` |
| `audit:comments-bot` | comments in `packages/bot/src/**` |
| `audit:comments-web` | comments in `packages/web/**` (app + src) |
| `audit:comments-shared` | comments in `packages/shared/src/**` |
| `audit:comments-research` | comments in `packages/research/src/**` |

- [ ] **Step 1: Dispatch all 8 agents in parallel (single message, 8 Agent calls, subagent_type: Explore for read-only)**

Use this prompt template for every agent, substituting `<SURFACE FILES>` and the ADR rule where relevant:

```
You are auditing documentation for staleness and verbosity. READ-ONLY — make NO edits.

Surface to audit: <SURFACE FILES>

For each file:
1. Read it.
2. For every factual claim about the code (module names, file paths, ports,
   function/flow descriptions, config var names, store choices, command names),
   verify it against the CURRENT code. Use `graphify query "<claim>"`,
   `graphify explain "<concept>"`, `graphify path "<A>" "<B>"`, and targeted Reads.
   Do NOT trust memory.
3. Identify verbose prose or comments that merely restate code, and propose a tighter version.

ADR RULE (only if auditing docs/adr/*): report factual drift ONLY (wrong paths,
renamed modules, dead refs, stale code snippets). NEVER propose rewriting a
decision, rationale, or narrative. If the whole ADR's decision no longer matches
reality, set adr_flag: true and describe why — do not propose an edit.

Return ONLY a JSON array of findings, each:
{ "file": str, "location": str (line range/heading/symbol), "category": "staleness"|"concision",
  "severity": "high"|"medium"|"low", "claim": str, "reality": str (or "unverifiable"),
  "proposed_fix": str (replacement text, or "delete"), "adr_flag": bool (optional) }

If a claim can't be verified against code, set reality:"unverifiable", severity:"low".
Skip files with no findings. Be precise; quote exact current text in "claim".
```

- [ ] **Step 2: Confirm all 8 returned**

If any agent returned nothing/errored, re-dispatch that one surface. No silent coverage loss — every surface must have a result (an empty array is a valid result; a missing agent is not).

### Task 2: Merge findings into the audit doc

**Files:**
- Create: `docs/superpowers/specs/2026-06-16-doc-cleanup-audit.md`

**Interfaces:**
- Consumes: the 8 findings arrays from Task 1.
- Produces: one markdown audit doc grouped by surface, each finding rendered as a reviewable row with a checkbox.

- [ ] **Step 1: Write the audit doc**

Structure: one `##` section per surface (in the table order above). Under each, a count summary then one entry per finding:

```markdown
## audit:docs-top

3 findings (1 high, 2 low)

- [ ] **[staleness/high]** `docs/ARCHITECTURE.md` (§Data stores, L120)
  - Claim: "bot binds :3000"
  - Reality: bot binds :3001 (web owns :3000) — main.ts:14
  - Fix: change ":3000" → ":3001"
```

Sort within each surface: staleness before concision, then high→low severity. Put any `adr_flag:true` items in a dedicated `## ⚠ Flagged ADRs (human decision required)` section at the top.

- [ ] **Step 2: Commit the audit doc**

```bash
git add docs/superpowers/specs/2026-06-16-doc-cleanup-audit.md
git commit -m "docs: phase-1 findings for documentation cleanup audit

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 3: Per-surface approval gate

- [ ] **Step 1: Present each surface's findings to the user, one group at a time**

For each surface: show the findings, ask approve / reject / amend per item. Record approvals (check the boxes in the audit doc for approved items; strike or annotate rejected ones). Do not proceed to Phase 2 for a surface until its group is decided. Flagged ADRs are surfaced for decision but never auto-edited.

---

## Phase 2 — Apply approved fixes

> Repeat the task below once per surface that has ≥1 approved finding. Surfaces with no approvals are skipped. Order: docs-top, adr (combined), readmes, then the four comment surfaces.

### Task 4: Apply a surface's approved fixes (template, per surface)

**Files:**
- Modify: the files named in that surface's approved findings (exact paths from the audit doc).

**Interfaces:**
- Consumes: approved findings for this surface from `2026-06-16-doc-cleanup-audit.md`.

- [ ] **Step 1: Apply each approved fix**

Edit the exact `location` with the `proposed_fix`. For `category:concision` "delete" items, remove the line/comment. Skip any item not approved and any `adr_flag:true` item.

- [ ] **Step 2: Build / typecheck sanity (skip for pure-markdown surfaces)**

For comment surfaces, JSDoc edits can affect typedoc/inference:

```bash
pnpm build
```
Expected: build succeeds (green). If a comment edit broke it, revert that edit.

- [ ] **Step 3: Run tests if any edited doc is asserted against**

```bash
pnpm test
```
Expected: no new failures vs. baseline. (Pure prose edits won't affect tests; run only if a comment/JSDoc surface was touched.)

- [ ] **Step 4: Commit this surface atomically**

```bash
git add <edited files>
git commit -m "docs: <surface> — fix drift & tighten (<ADR-NNNN if relevant>)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 5: Final verification & graph refresh

- [ ] **Step 1: Full build + test green**

```bash
pnpm build && pnpm test
```
Expected: both green, no new failures vs. the pre-cleanup baseline.

- [ ] **Step 2: Refresh the knowledge graph (code comments changed)**

```bash
graphify update .
```

- [ ] **Step 3: Report**

Summarize: findings count per surface, approved vs. rejected, ADRs flagged, commits made. Confirm flagged ADRs are still pending the user's decision.

---

## Self-Review

- **Spec coverage:** Two-phase pipeline (✓ Phases 1/2), 8-surface partition (✓ Task 1 table), findings schema (✓ Global Constraints + Task 1), ADR accuracy-only + flag (✓ Global Constraints, Task 1 prompt, Task 3), per-surface approval (✓ Task 3), atomic commit per surface (✓ Task 4), build/test sanity (✓ Tasks 4–5), exclusions (✓ Global Constraints), audit doc deliverable (✓ Task 2). All spec sections mapped.
- **Placeholder scan:** No TBD/TODO; agent prompt and findings rendering shown in full.
- **Type consistency:** Findings schema identical in Global Constraints, Task 1 prompt, and Task 2 rendering. Surface labels consistent between Task 1 table and Phase 2 ordering.
