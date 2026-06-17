# Documentation Cleanup — Phase 1 Findings

Read-only audit, 8 parallel agents, cross-checked against current code. Grouped by
surface. Each finding: `[category/severity]`, current claim → reality → proposed fix.
Check the box to approve. Items marked **no change needed** by agents were dropped.

---

## ⚠ Flagged: decision-vs-reality mismatch (human decision — not auto-edited)

These are ADR/decision-level mismatches, not factual typos. Per the ADR rule they are
NOT auto-edited; you decide.

- [ ] **F1 — ADR-0027** `docs/adr/0027-engagement-is-the-unit-behind-streak-xp-wellness.md` (Consequences)
  - Claim: "The `xpEntry` table becomes the Engagement log; rows carry the habit and its points. Streak, XP total, and Wellness Score are read models over it."
  - Reality: Prisma schema still has `model XpEntry` (id, userId, amount, reason, createdAt) — no `habit` column, no `Engagement` model. The migration this ADR describes was never applied (`schema.prisma:111`).
  - Decision needed: leave ADR as the aspirational record, or annotate that the migration is pending? (Not a path typo — the decision itself isn't reflected in code.)

---

## Surface: docs-top (top-level docs)

### Staleness
- [ ] **[high]** `CLAUDE.md` L11 — "every structural decision (0001–0025)" → 35 ADRs exist (0001–0035). Fix: "(0001–0035)".
- [ ] **[high]** `README.md` (ADR line) — "every structural decision (0001–0025)" → same. Fix: "(0001–0035)".
- [ ] **[high]** `CLAUDE.md` L54 — "`@wabi/research` — standalone TypeScript worker (not NestJS) … Run via `pnpm -F research start` (`ts-node src/run.ts`, `--topic`…)" → research is now an always-on NestJS service on :3002 (ADR-0034); `package.json` dev = `RESEARCH_PORT=3002 nest start --watch`. Fix: rewrite bullet to "always-on NestJS service (ADR-0034, :3002) … Run via `pnpm -F research dev` / `start:prod`." (keep the `RESEARCH_*`/`RESEARCH_TRIAGE_*`→`CLASSIFIER_*` provider note).
- [ ] **[high]** `docs/ARCHITECTURE.md` L26 — "`/admin/drafts` Strategy review" → actual route is `/admin/strategies` (page.tsx, admin-tabs.tsx). Fix: "`/admin/strategies`".
- [ ] **[medium]** `README.md` L33 — research table row says "Standalone research worker" → now always-on NestJS service (:3002, ADR-0034). Fix: update row text.
- [ ] **[medium]** `docs/ARCHITECTURE.md` ADR index (~L175–185) — lists only to 0022/0025 → 0023–0035 exist; 11 system-shaping ADRs missing. Fix: extend index (0023,0024,0026–0035).
- [ ] **[medium]** `docs/ARCHITECTURE.md` Components — research package absent entirely → add `research` NestJS service (:3002, ADR-0034) to Application processes + topology diagram.
- [ ] **[medium]** `docs/agents/domain.md` L18–28 — file-structure example shows `src/<context>/docs/adr/` → repo has no `src/`; contexts live at `docs/contexts/<context>/CONTEXT.md`, no nested ADR dirs. Fix: replace with wabi layout, drop the `src/<context>/docs/adr/` instruction.
- [ ] **[low]** `docs/PLAN.md` L7 / Task1 — "monorepo (bot, web, shared)" + root `prisma/` + "Vercel AI SDK" → 4 packages (research added); schema at `packages/shared/prisma/`. **Note:** PLAN.md is a historical plan with an "ADRs win" header — recommend leaving, or a one-line pointer. (Vercel AI SDK presence = unverifiable.)

### Concision
- [ ] **[low]** `docs/contexts/wellbeing/CONTEXT.md` Screened-record write (L33–40) — definition + following paragraph restate ADR-0031 twice. Fix: merge into one definition (agent supplied merged text).
- [ ] **[low]** `docs/contexts/wellbeing/CONTEXT.md` Spoke/Tool defs (L45–54) — verbose vs sibling glossary entries. Fix: tighten (agent supplied shorter text).

---

## Surface: ADRs

### Staleness (factual drift — accuracy-only edits)
- [ ] **[high]** `0019-nestjs-for-the-bot-backend.md` (intro) — "the `/admin/drafts` review surface" → no such route; it's `/admin/strategies`. Fix: replace.
- [ ] **[medium]** `0005-paid-only-…md` (¶1 + Consequences) — "replaced by a single `hasActiveAccess` field" → not a DB column; computed accessor in `packages/shared/src/access.ts` from `trialEndsAt`/`subscriptionStatus`. Fix: "computed `hasActiveAccess` accessor (see `access.ts`)".
- [ ] **[medium]** `0011-trial-and-access-lifecycle.md` (Consequences) — "replaced by a single `hasActiveAccess` boolean … data model" → same: computed accessor, not a model field. Fix: as above.
- [ ] **[low]** `0001-non-clinical-positioning.md` (Consequences) — "see `CONTEXT.md`" → root file is `CONTEXT-MAP.md` → `docs/contexts/<context>/CONTEXT.md`. Fix: correct the reference.
- [ ] **[low]** `0013-no-durable-transcript-store.md` — "`AiConversation` … (`sessionId`, `topic`)" → model has `userId`, `topic` (no `sessionId`) at `schema.prisma:67-74`. Fix: "(`userId`, `topic`)".
- [ ] **[low]** `0017-self-hosted-embeddings…md` (opening) — "e.g. TEI/Infinity serving `bge-base-en-v1.5`" contradicts this file's own 2026-06-06 amendment (`nomic-embed-text-v2-moe`). Fix: align opening example to amendment.
- [ ] **[low]** `0012-strategy-quality-gate.md` (opening) — "(`research-cron`, `session-mining`)" → no such named pipelines; research worker (ADR-0034) + session sweeper draft-submission. Fix: replace names.
- [ ] **[low]** `0009-self-hosted-data-swappable-llm.md` — "OpenAI (GPT-4o) for PoC only" + "self-hosted" → superseded by privately-managed single-tenant endpoints (ADR-0017 amendment). **Borderline:** edits rationale wording. Recommend a light pointer to the 0017 amendment rather than rewriting. Approve text on review.
- [ ] **[low]** `0021-graceful-degradation…md` (Consequences) — "`crisis-resources.json` must ship in the bot image" → JSON file is a dead artifact; data is a hardcoded `RESOURCES` const in `crisis-resources.service.ts`. Fix: "hardcoded in `crisis-resources.service.ts` (`RESOURCES` const), ships compiled into the image".
- [ ] **[low]** `0023-served-region-scope…md` (Consequences) — "`crisis-resources.json` (Task 30) ships with…" → same dead-artifact issue; selection logic lives in service. Fix: re-point to the service const.

(ADR-0015 `MessageContent` launch-gate, ADR-0009 "self-hosted" nuance = unverifiable/operational — left as-is.)

---

## Surface: package READMEs

### Staleness
- [ ] **[medium]** `packages/research/README.md` L40–41 — implies `cron-compile/` is under `schedule-service/` → it's top-level `src/cron-compile/`. Fix: own bullet.
- [ ] **[medium]** `packages/research/README.md` L33–34 — "ConfigModule … (replaces the old hand-rolled `loadDotenv()`)" → `loadDotenv()` still exists in `util/load-env.ts` for scripts. Fix: drop/adjust parenthetical.
- [ ] **[medium]** `packages/web/README.md` L31 — "`api/consent/` — consent persistence" → routes are `api/consent/accept/` + `api/consent/decline/`. Fix: list both.
- [ ] **[medium]** `packages/web/README.md` L29–32 — omits `api/admin/research/[...path]/` proxy. Fix: add it.
- [ ] **[low]** `packages/web/README.md` L27 — admin section lists only `admin/strategies/` → `admin/research/` also exists. Fix: add `admin/research/`.
- [ ] **[low]** `packages/shared/README.md` L14–17 — roles list omits `router` (`ProviderRole` includes it, `provider.ts:1`). Fix: add `router`.
- [ ] **[low]** `packages/bot/README.md` L32 — "`src/lib/` holds … (sentry, setup-link)" → 7 files there. Fix: either list all or generalize to "cross-module helpers".
- [ ] **[low]** `packages/research/README.md` L66 — "joins root `pnpm dev`" → unverifiable (CLAUDE.md says `pnpm dev` excludes community; research join unclear). Flag, verify at apply time.

### Concision
- [ ] **[low]** `packages/research/README.md` L57–63 — trailing "operator drives all of these from `/admin/research`" duplicates the section header. Fix: delete trailing sentence.
- [ ] **[low]** `packages/research/README.md` L72–75 — degraded/re-assert detail duplicates Nest-layout section. Fix: condense to one line.

---

## Surface: comments — bot

### Staleness
- [ ] **[high]** `coaching/coaching.service.ts` L165-167 — "Observe-only … before any intent actually changes behaviour (Slice A2)" → router is live; `dmRouter.dispatch()` at L229. Fix: drop observe-only framing.
- [ ] **[high]** `langfuse/trace-payload-builder.ts` L1-2 — "retrieval/memory are wired in later slices" → both emitted now (coaching.service L186, coach-handler L98). Fix: "classify, intent, coach, retrieval, memory."
- [ ] **[medium]** `coaching/dm-router.service.ts` L40 — "for the observe-only intent trace" → no longer observe-only. Fix: drop "observe-only".
- [ ] **[medium]** `intent-router/intent-router.service.ts` L39-43 — "so later slices can feed recent turns" → already fed (coaching.service L123). Fix: rewrite to describe current use.
- [ ] **[medium]** `memory/inner-state-memory.service.ts` L11-12 — "every caller invokes it inside … `guard()` success closure" → only caller is `InnerStateRecorderService.record()` via branded `Screened` proof (ADR-0031), not `guard()`. Fix: rewrite to type-enforced invariant.
- [ ] **[medium]** `lib/json-logger.ts` L76 — "`logger.error('msg', err.stack)`" → `err.stack` is a string, caught by the string branch; correct example is `err` (the Error). Fix: correct example.
- [ ] **[medium]** `scheduler/scheduler.service.ts` L19-27 — describes the "five services each `new PgBoss`" before-state + old `work()/cron()` API now unused in prod. Fix: rewrite docblock to current registry seam.

### Concision
- [ ] **[low]** `scheduler/job-registry.ts` L9 — historical "before this, each owner called `scheduler.cron`/`work`…" tombstone. Fix: tighten to current design.
- [ ] **[low]** `memory/memory.module.ts` L8-11 — removed-service bug tombstone (issue #22). Fix: condense to current responsibility.
- [ ] **[low]** `lib/setup-link.ts` L6 — "(There is no /onboard page; that was a dead link — issue #28.)" tombstone. Fix: delete.
- [ ] **[low]** `coaching/coaching.service.ts` L74 + L214-215 — trailing `(#31 / #12)` scratch-tracker refs, not browsable. Fix: drop the issue numbers.

---

## Surface: comments — web

### Staleness
- [ ] **[high]** `consent/page.tsx` L32 — `{/* TODO(LEGAL): Replace with final consent wording */}` → placeholder legal copy. Action: replace with final copy OR track as blocking pre-launch issue (not silently shipped). **Needs your call.**
- [ ] **[medium]** `middleware.ts` L54 — "Next.js 15.5 makes Node.js Middleware stable" → installed is `^15.1.0`. Fix: "Next.js 15".
- [ ] **[medium]** `api/auth/discord/callback/route.ts` L43 — "GDPR Art. 9 / ADR-0009 require explicit consent before we persist" → ADR-0009 is self-hosted-data/swappable-LLM, not consent; correct cite is ADR-0002 (privacy-by-construction) / ADR-0011. Fix: re-cite.
- [ ] **[medium]** `api/admin/strategies/[...path]/route.ts` L5-10 — JSDoc says "forwards" generically but only GET+POST exist (research proxy has all 5 verbs). Fix: note "GET+POST only" (don't add unused verbs — YAGNI).
- [ ] **[low]** `api/consent/accept/route.ts` L22-23 — "computed by the shared Entitlement module" → no `Entitlement` module; it's `trialGrant()` in `access.ts`. Fix: "shared access module (`trialGrant`)".

### Concision
- [ ] **[low]** `dashboard/dashboard-view.tsx` L47-48 — comment duplicates the rationale already on `page.tsx` L30-32 (where `decideAccess` is called). Fix: delete the view-level copy.

---

## Surface: comments — shared

### Staleness
- [ ] **[medium]** `sentry-scrub.ts` L7 — "both web runtimes (`@sentry/nextjs`)" → only server + edge configured (no client config); phrasing implies completeness. Fix: "the web server and edge runtimes".

### Concision
- [ ] **[low]** `sentry-scrub.ts` L8-9 — past-tense divergence narrative (bot scrubbed `request.data`; web didn't) describes a completed refactor. Fix: drop parenthetical.
- [ ] **[low]** `access.ts` L1-5 — JSDoc calls `SubscriptionStatus` an "enum" → it's a union type alias. Fix: "type"/"union type".
- [ ] **[low]** `access.ts` L9 — "/** Derived (decideAccess) — … never persisted. */" → "(decideAccess)" redundant. Fix: "Used for runtime gating only — never persisted."
- [ ] **[low]** `provider.ts` L9-14 — incident narrative is warranted here (canonical lazy-load explanation) but can shorten. Fix: optional light trim (agent supplied text). Approve on review.
- [ ] **[low]** `provider.ts` L41-44 — "faithful, generalized technique extraction with verbatim grounding" describes task role, not config. Fix: trim to the fallback-chain explanation.

---

## Surface: comments — research

### Staleness
- [ ] **[high]** `util/load-env.ts` L5-8 — JSDoc "for the standalone worker … this process has no such loader" → worker is NestJS w/ ConfigModule; `loadDotenv()` only used by scripts/tests. Fix: reframe as "for standalone/script callers".
- [ ] **[high]** `schedule-service/research-schedule.service.ts` L7 — "queue this worker schedules + (in a later slice) consumes" → already consumed (`research-run.service.ts:87-91`). Fix: "schedules and consumes".
- [ ] **[high]** `schedule-service/research-schedule.service.ts` L28-29 — "NOTE (this slice): … worker that consumes `research-run` arrives in the next slice" → consumer exists now. Fix: delete the NOTE.
- [ ] **[medium]** `util/logger.ts` L2-4 — "STDOUT stays clean for the final run-summary JSON" → no run-summary JSON to STDOUT (result persisted to Postgres). Fix: "so it doesn't mix with process-level STDOUT output".
- [ ] **[medium]** `run.ts` L22-25 — "retired CLI `main()` … loads env via ConfigModule rather than hand-rolled dotenv" → accurate but dead migration context. Fix: trim to current-state docblock.
- [ ] **[low]** `run-service/research-runner.service.ts` L14, L29, L106-107 — three "the retired `main()`" historical references; CLI is gone. Fix: drop the comparisons (3 spots).

### Concision
- [ ] **[low]** `admin/research-admin.controller.ts` L27-29 — "Slice 01 … slice 05 adds…" changelog in prod code. Fix: delete slice-history sentence.
- [ ] **[low]** `run-service/research-run.service.ts` L213-220 + L268-275 — "Fix 1"/"Fix 2" dev-era tags. Fix: replace with "(ADR-0034):".
