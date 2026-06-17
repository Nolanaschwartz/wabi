# Research Worker Scheduling — Design Spec

**Date:** 2026-06-16
**Branch:** `feat/research-worker-scheduling`
**Related ADRs:** new **ADR-0034** (research is a separate always-on NestJS service); amends **ADR-0033** (research-strategy ingestion always queues); cites **ADR-0018** (research-cron intent), **ADR-0019/0020** (always-on, never serverless).

## Problem Statement

There is no way for an operator to control when the research agent runs. Today `@wabi/research` is a one-shot CLI (`ts-node src/run.ts`) with a hardcoded seed-topic list and env-only bounds. Running it requires shell access; there is no schedule, no UI, no run history, and the worker reads `.env` via a hand-rolled `loadDotenv()` hack because it has no Nest `ConfigModule`.

The operator wants to set a schedule for the research agent from the admin page, and to manage what it runs (topics) and how hard it runs (bounds).

## Solution

Restructure `@wabi/research` from a one-shot CLI into a **separate, always-on NestJS service** that owns its own schedule (pg-boss), config, and run history, and exposes an authenticated admin HTTP surface. A new `/admin/research` page in `@wabi/web` lets an operator edit the schedule, topics, and bounds, trigger a run on demand, and see recent run outcomes.

The worker stays a **pure candidate producer**: it still POSTs candidates to the bot's trust gate over HTTP. Only its *trigger* and *config* become self-owned.

## Scope

In scope: cadence (schedule), seed-topic management, run-bounds tuning, a manual "Run now", and run history — all admin-editable.

Out of scope (separate future project, see Sequencing): extracting the Strategy knowledge base (trust gate + `StrategyDraft` + Qdrant + retrieval) out of the bot into its own Strategy API service. The worker is already a decoupled HTTP client (`BotClient`, configurable base URL), so that extraction is later an env flip with zero rework here.

## Architecture

Three actors over the same Postgres / pg-boss instance:

- **`@wabi/web`** — `/admin/research` page; `/api/admin/research/*` proxy (lucia + operator gate) → forwards to the worker with `x-admin-secret`.
- **`@wabi/research` (NEW Nest app, always-on, `:3002`)** — owns research config (topics/bounds), the schedule (it `boss.schedule()`s the very `research-run` queue it consumes — single owner), run-now, run history, and the admin HTTP endpoints for all of it. Reads topics/bounds from DB; writes `ResearchRun` history; POSTs candidates to `STRATEGY_API_URL` (default = bot).
- **`@wabi/bot`** — **unchanged**. Keeps `/admin/strategies/ingest` (trust gate → `StrategyDraft` → Qdrant) and existing draft-review endpoints. Learns nothing about scheduling.

```
┌──────────┐  research config/schedule/runs   ┌────────────────────────┐
│ Operator │ ───────────────────────────────▶ │ @wabi/research (Nest)   │
└────┬─────┘   web proxy → RESEARCH_API_URL    │  HTTP admin + worker     │
     │         (lucia + operator gate)         │  • research-admin ctrl   │
     │                                         │  • boss.schedule()  ─────┼─┐ owns its OWN cron
     │  strategy draft review (existing)       │  • boss.send() run-now   │ │
     │                                         │  • work('research-run') ◀┼─┘ consumes own queue
     └──────────────────────────┐              │  • reads topics/bounds   │   (singleton)
                                 │              │  • writes ResearchRun    │
                                 ▼              └───────────┬─────────────┘
                          ┌──────────────┐      POST /ingest │ (candidates only)
                          │  @wabi/bot    │ ◀────────────────┘
                          │  strategy-admin (UNCHANGED): trust gate, StrategyDraft, Qdrant │
                          └──────────────┘
```

**Division of labour:**
- Worker owns the entire research surface (config, schedule, run-now, history, admin HTTP). It is the single owner of the `research-run` queue: it both schedules and consumes it.
- Bot is untouched; the worker remains a pure producer over HTTP via a configurable `STRATEGY_API_URL` (the forward-compat seam for the future Strategy-API extraction).
- Web proxy fans out: `research/*` → `RESEARCH_API_URL`; existing `strategies/*` → `BOT_API_URL`. One operator gate covers both.

**Why ingest stays on the bot:** `StrategyDraft`, the trust gate, Qdrant indexing, and strategy retrieval are the bot's coaching domain (ADR-0033). The worker emits candidates; the bot decides what becomes a strategy.

## Data Model (Prisma, in `@wabi/shared`)

Three new tables, all owned by the worker, disjoint from the bot's `StrategyDraft`/`ProcessedSource`.

**`ResearchConfig`** — singleton row (schedule + bounds in one place):
```
id              String   @id @default("singleton")   // enforced single row
scheduleCron    String?                              // null = unscheduled
scheduleEnabled Boolean  @default(false)
maxTopicsPerRun    Int   @default(5)
maxPapersPerTopic  Int   @default(8)
maxDiscoverySteps  Int   @default(2)
maxDraftsPerTopic  Int   @default(3)
maxDraftsPerRun    Int   @default(10)
agentTimeoutMs     Int   @default(90000)
runTimeoutMs       Int   @default(600000)
tokenBudget        Int   @default(200000)
updatedAt       DateTime @updatedAt
```

**`ResearchTopic`** — the editable seed list (replaces hardcoded `SEED_TOPICS`):
```
id        String   @id @default(cuid())
text      String   @unique
enabled   Boolean  @default(true)
createdAt DateTime @default(now())
updatedAt DateTime @updatedAt
```

**`ResearchRun`** — history / observability (mirrors the run summary the worker already computes):
```
id          String    @id @default(cuid())
trigger     String                        // 'scheduled' | 'manual'
status      String    @default("running") // 'running' | 'success' | 'failed'
startedAt   DateTime  @default(now())
finishedAt  DateTime?
submitted   Int       @default(0)
deduped     Int       @default(0)
rejected    Int       @default(0)
errors      Int       @default(0)
collected   Int       @default(0)
tokensUsed  Int       @default(0)
topicsRun   Int       @default(0)
stopReason  String?
error       String?                        // populated on status='failed'
@@index([startedAt])
```

**Seeding / source of truth:** on first boot the worker upserts the `ResearchConfig` singleton (defaults above mirror today's env defaults) and seeds `ResearchTopic` from the existing `seed-topics.ts`. After that, **DB is the source of truth**; `loadBounds()` / `SEED_TOPICS` / `RESEARCH_MAX_*` env vars demote to bootstrap defaults only.

**Single-flight:** `research-run` is a pg-boss singleton queue, so a manual "Run now" landing during a scheduled run collapses to one active run; the `status='running'` row is the secondary guard.

## Worker Nest Structure

`main.ts` bootstraps a full Nest HTTP app and binds `:3002` (web :3000, bot :3001).

```
AppModule
├─ ConfigModule.forRoot({ isGlobal, envFilePath: <repo-root>/.env })   ← replaces loadDotenv() hack
├─ PrismaModule            (shared client; worker now has DATABASE_URL)
├─ SchedulerModule         (thin pg-boss wrapper ported from the bot's SchedulerService:
│                           start / work / send / schedule / unschedule)
└─ ResearchModule
   ├─ ResearchConfigService    reads/writes ResearchConfig + ResearchTopic; seeds on boot
   ├─ ResearchScheduleService  applies schedule → pg-boss; registers work('research-run')
   ├─ ResearchRunnerService    run handler: loads DB config, calls existing runResearch core
   ├─ ResearchAdminController  HTTP admin endpoints
   └─ AdminGuard               x-admin-secret, timing-safe (mirrors bot's)
```

**Preserved vs new:** the pure core is untouched — `runResearch`, `ResearchAgent`, `agent/*`, `sources/*`, `BotClient`. They are *wrapped* by `ResearchRunnerService`, not rewritten. `BotClient` keeps pointing at a configurable base URL (`STRATEGY_API_URL`, default = bot). **Retired:** the standalone `run.ts main()` + `loadDotenv()` (logic moves into the runner service; `ConfigModule` handles env). The lazy-getter rule still holds — `getProvider()` re-reads `process.env`, which `ConfigModule` populates at bootstrap.

**Schedule-apply flow (no restarts, no subprocess):**
1. **Boot** → `SchedulerService.start()` opens pg-boss. `ResearchScheduleService.onModuleInit()` registers `work('research-run', handler)` (singleton), then reads `ResearchConfig` and **re-asserts**: `enabled && cron` → `boss.schedule('research-run', cron, { tz })`, else `boss.unschedule('research-run')`. Survives restarts.
2. **Admin saves schedule** → config persisted → `ResearchScheduleService.apply()` immediately re-asserts `schedule`/`unschedule` in-process. Live, no redeploy.
3. **Cron fires** (or **Run now** → `boss.send('research-run', {trigger:'manual'})`) → same singleton handler.
4. **Handler** (`ResearchRunnerService.run`): insert `ResearchRun{status:'running', trigger}` → load enabled `ResearchTopic`s + bounds from DB → run the core → update the row to `success` + summary counts, or `failed` + error.

**Timezone:** cron is interpreted in `RESEARCH_TZ` (env, default `UTC`) and passed to `boss.schedule`. The cadence picker compiles to a cron string against that TZ.

## Admin Endpoints + Web UI

**Worker endpoints** (`ResearchAdminController`, all behind `AdminGuard` / `x-admin-secret`):

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/admin/research/config` | `{ schedule:{cron,enabled,tz}, bounds:{…}, topics:[…] }` — one fetch for the whole screen |
| `PUT` | `/admin/research/schedule` | `{cron, enabled}` → persist + immediately re-assert pg-boss |
| `PUT` | `/admin/research/bounds` | `{…bounds}` → persist (server-validated ranges) |
| `POST` | `/admin/research/topics` | `{text}` → add |
| `PATCH` | `/admin/research/topics/:id` | `{text?, enabled?}` → edit / toggle |
| `DELETE` | `/admin/research/topics/:id` | remove |
| `POST` | `/admin/research/run` | enqueue manual run → `{runId}` |
| `GET` | `/admin/research/runs?limit=20` | recent `ResearchRun` rows |

**Auth:** the worker `AdminGuard` reuses the existing `ADMIN_API_SECRET` (the secret the web proxy already sends to the bot) — one secret, both backends. Fails closed if unset.

**Cron validation:** server-side via a cron parser on `PUT /schedule` (reject malformed before it reaches pg-boss). The picker is a convenience over the canonical cron string the API stores.

**Web side:**
- **New proxy** `packages/web/src/app/api/admin/research/[...path]/route.ts` — clone of the strategies proxy, targets `RESEARCH_API_URL` (default `http://localhost:3002`) with `x-admin-secret`. Same `requireAuthenticated()` + `isOperator()` defense-in-depth.
- **No middleware change** — `middleware.ts` already prefix-matches `/admin` and `/api/admin`, so `/admin/research` and `/api/admin/research` are gated automatically.
- **New page** `packages/web/src/app/admin/research/page.tsx` (client component, same shape as `strategies/page.tsx`), four panels:
  1. **Schedule** — cadence picker (Daily / Weekly / Monthly + time-of-day, + day-of-week / day-of-month as needed) → compiles to a cron string; an **Advanced** raw-cron field; enable toggle; **Run now** button.
  2. **Topics** — list with add / remove / per-row enable toggle.
  3. **Bounds** — number inputs for the eight bounds fields.
  4. **Recent runs** — table: trigger, status, started, submitted/deduped/rejected/errors, stopReason.

## Isolation / ADRs

- **New ADR-0034** — "Research is a separate always-on NestJS service." Records: own Nest app + HTTP (:3002) + pg-boss consumer; self-owns research config / schedule / run-history; gains `DATABASE_URL` **scoped to research tables + pg-boss only — never user data, never `StrategyDraft`**; candidates still flow through the bot trust gate over HTTP via configurable `STRATEGY_API_URL`. Cites ADR-0018, ADR-0019/0020.
- **Amend ADR-0033** — "no DB creds" → "no *user-data* access"; the worker self-owns its trigger + config but stays a pure candidate producer behind the trust gate.

## Environment (new / changed)

- **Worker:** `DATABASE_URL` (now used), `RESEARCH_PORT=3002`, `RESEARCH_TZ=UTC`, `STRATEGY_API_URL` (default = bot, the ingest target; aliases today's `BOT_BASE_URL`), `ADMIN_API_SECRET` (now also guards the worker). `RESEARCH_MAX_*` bounds vars demote to **seed defaults only** (documented as such).
- **Web:** `RESEARCH_API_URL=http://localhost:3002`.
- **Unchanged trap:** `packages/shared/.env` stays **DATABASE_URL only**; the worker's `ConfigModule` reads the root `.env`.

## Ops

- Root `pnpm dev` also starts the worker; add a `dev:research` script. Three app processes + web.
- Worker fails safe: DB / pg-boss down → no scheduling, admin endpoints return 503, nothing else affected. Research is non-critical by construction.
- One Prisma migration for the three tables; idempotent seed-on-boot.

## Testing (TDD)

- **Unit:** `ResearchConfigService` (seed idempotency, topic CRUD, bounds validation) · `ResearchScheduleService` (apply → schedule/unschedule, cron-reject, boot re-assert; mocked scheduler) · `ResearchRunnerService` (running-row → core → success/failed summary; single-flight) · `AdminGuard` (reuse bot's fail-closed spec) · `ResearchAdminController` (routing/validation, mocked services) · cron-compile helper (presets → cron, reject malformed).
- **Existing 68 agent/sources specs stay green** — core untouched.
- **Integration** (`*.integration.ts`, existing testcontainers harness): boot seeds config → schedule apply writes a pg-boss schedule → run-now enqueues → handler runs against a stubbed `STRATEGY_API_URL` and writes a `ResearchRun` row.
- **Web:** proxy-route test (operator gate + forward to `RESEARCH_API_URL` with secret).

## Out of Scope

- Strategy-API extraction (bot becomes a retrieval client) — separate brainstorm + ADR.
- Per-topic schedules (one global cadence for the whole run in v1).
- Multi-timezone per-operator scheduling (single `RESEARCH_TZ`).
- medRxiv full-text ingestion (still abstract-only, unchanged).
