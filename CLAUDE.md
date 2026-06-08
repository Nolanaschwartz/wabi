# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Wabi is

A **DM-first, non-clinical wellness companion for gamers on Discord** (ADR-0001/0003). A person talks to it in their Discord DMs like a friend; it coaches them using memory and evidence-based strategies, behind a hard crisis-safety boundary that overrides all other behaviour. v1 is single-process and always-on.

Read these before non-trivial work — they are the source of truth, and **ADRs win where docs disagree**:
- `docs/ARCHITECTURE.md` — the consolidated system design, key flows, personal-data map.
- `docs/adr/` — the *why* behind every structural decision (0001–0025). The hot path, gating rules, and store choices all trace to a numbered ADR.
- `CONTEXT-MAP.md` → `docs/contexts/<context>/CONTEXT.md` — the domain vocabulary. Contexts (Wellbeing / Accounts & Billing / Community) are **language boundaries, not packages**.

## Commands

Run from repo root unless noted. Package manager is **pnpm** (workspace).

```bash
pnpm dev            # all packages in parallel (web :3000, bot :3001); excludes community
pnpm dev:bot        # bot only (nest --watch)
pnpm dev:web        # web only (next dev)
pnpm build          # build all packages
pnpm test           # run every package's tests
pnpm db:push        # prisma db push  (delegates to @wabi/shared)
pnpm db:generate    # prisma generate (regenerate client after schema edits)
```

Bot tests (from `packages/bot`):
```bash
pnpm test                              # jest unit specs (*.spec.ts)
pnpm test -- path/to/file.spec.ts      # single file
pnpm test -- -t "name of test"         # single test by name
pnpm test:integration                  # *.integration.ts — spins real Postgres/Redis/Qdrant via testcontainers (Docker required)
```

Shared/db (from `packages/shared`): `db:migrate:dev` (create+apply migration), `db:studio`, `db:migrate` (deploy).

## Local dev startup

1. Docker Desktop running → `docker compose up -d postgres redis qdrant mem0` (also: neo4j, glitchtip).
2. `pnpm dev`. The bot binds **:3001** (web owns :3000). It comes online even if infra is down (degraded), so the Discord gateway never blocks on Redis.

**Env-file traps (important):**
- Root `.env` is the canonical app config the **bot** reads. `.env.example` documents every var.
- `packages/shared/.env` must contain **only `DATABASE_URL`**. Prisma auto-loads it at import time, *before* the bot's `ConfigModule`, and dotenv never overrides an already-set var — so anything else there silently shadows the root `.env`.
- `packages/web/.env` is Next.js config. All `.env` files are gitignored.

## Architecture essentials

Three workspace packages (`packages/*`); there is no `apps/`:
- **`@wabi/bot`** — NestJS 11 + necord over discord.js v14. The heart of the system: Discord gateway, the crisis→coaching pipeline, the Stripe webhook controller, and the pg-boss worker/scheduler. Must be always-on; never serverless (ADR-0019/0020).
- **`@wabi/web`** — Next.js 15 App Router. Landing, Discord OAuth + consent + trial + `User` creation, Stripe checkout, dashboard, `/admin/drafts` strategy review. Sessions via lucia.
- **`@wabi/shared`** — plain TypeScript: Prisma client + generated types, constants, and the swappable-provider + access resolvers. Imported by both other packages.

### Bot module layout

`packages/bot/src/modules/<feature>/` is a NestJS module per feature (coaching, crisis, memory, billing, mood, tilt, journal, playtime, streaks, xp, checkins, welcome, data-rights, strategy-admin, strategy-retrieval, session-buffer, burst-coalescer, crisis-aftermath, langfuse, health, echo). Each owns its `.module.ts`, services, and `__tests__/`. They are wired in `app.module.ts`. `src/lib/` holds cross-module helpers (sentry, setup-link).

### Data stores (ADR-0009 — self-hosted, swappable)

Postgres (Prisma, the only authoritative store) · Redis (ephemeral session buffer, persistence OFF) · Qdrant (strategy + personal vectors, 768-dim) · Mem0 (derived memory, hybrid Qdrant+neo4j) · neo4j (per-user graph) · local bge embeddings · Langfuse (traces) · GlitchTip (errors). Prisma models live in `packages/shared/prisma/schema.prisma`.

## Patterns that bite — follow these

- **Resolve config lazily, never at module-import time.** The bot process starts *without* inference/Langfuse env vars in `process.env`; `ConfigModule.forRoot` populates them later during Nest bootstrap, after `@wabi/shared` is already imported. Reading `process.env` at import froze providers to OpenAI defaults and broke the classifier (→ a crisis alert on every message). `getProvider(role)` in `packages/shared/src/provider.ts` re-reads `process.env` on every call by design; services call it from constructors (instantiated after config loads). The same lazy-getter rule applies to `LangfuseTracer.enabled`. **Don't cache env-derived state in a field or top-level const.**

- **Safety fails closed (ADR-0021).** A zero-dependency `crisisTripwire` runs on every DM before anything else. If the classifier can't run, coaching does **not** proceed. Crisis flow surfaces local resources, logs a content-free `EscalationEvent`, clears the Redis buffer, sets `doNotMine`, and never persists transcript content or notifies third parties. Treat the crisis/screening path as the highest-stakes code in the repo.

- **Gating by access tier (ADR-0011).** tripwire = always · classifier = when consented (active or lapsed) · coach + store + new logging = active access only · data read/export/delete = always. The DM path never creates a `User` — unknown/unconsented DMs get a setup link, never coaching.

- **No durable transcripts (ADR-0013).** Verbatim DMs are never persisted. Live turns live in Redis and evaporate at session end; a pg-boss sweeper derives Memory then deletes the key. Don't add transcript storage.

- **Privacy by construction (ADR-0002/0017).** Inner-state data (mood/tilt/journal) never crosses to a social surface; personal embeddings stay on local inference. Personal data leaves infra only to Discord/OpenAI(PoC)/Stripe.

## Working conventions

- **TDD is the norm here** — most features have a failing test added first, then the fix. Match that: write/extend the `*.spec.ts` alongside changes; run `pnpm test` before claiming done.
- **Issue tracker is local markdown** under `.scratch/<feature>/` (see `docs/agents/issue-tracker.md`), not GitHub Issues. Plans/specs live in `docs/superpowers/`.
- When a change is shaped by a decision, cite the ADR in the commit/PR as the existing history does (`fix(langfuse): …`, `feat(langfuse): …`).
