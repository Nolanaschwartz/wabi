# @wabi/bot

The heart of Wabi: a **NestJS 11 + necord** application over **discord.js v14**. It owns the
Discord gateway, the crisis→coaching pipeline, the Stripe webhook controller, and the pg-boss
worker/scheduler. It must be **always-on** (persistent gateway + worker) and is never
serverless (ADR-0019/0020).

It binds **:3001** locally (web owns :3000) and comes online even when infra is down
(degraded mode), so the Discord gateway never blocks on Redis.

## The coaching hot path

```
DM arrives (necord messageCreate)
  → crisisTripwire(text)             ── ALWAYS, zero-dependency (ADR-0021)
  → user lookup (never upserts)      ── unknown/unconsented → setup link, no coaching
  → consent / access gate            ── tier-based (ADR-0011)
  → debounce ~2-3s (coalesce burst)
  → classifier (fast model)  ∥  retrieval (embed → Mem0 + Strategy)
       ├─ crisis → escalate, discard retrieval, no coach/store
       └─ safe   → coach(context) → single message → append turn to Redis buffer
  ... later: pg-boss sweeper derives Memory → Mem0, then DELs the Redis key
```

The crisis/screening path is the highest-stakes code in the repo. Safety **fails closed**:
if the classifier can't run, coaching does not proceed.

## Module layout

`src/modules/<feature>/` is a NestJS module per feature, each owning its `.module.ts`,
services, and `__tests__/`. They are wired in `src/app.module.ts`. `src/lib/` holds
cross-module helpers (sentry, setup-link). `src/main.ts` is the bootstrap.

Modules, grouped by role:

- **Safety & coaching** — `crisis`, `crisis-aftermath`, `coaching`, `intent-router`,
  `memory`, `strategy-retrieval`
- **Inner-state logging** — `mood`, `tilt`, `journal`, `playtime`, `inner-state-logger`,
  `checkins`
- **Gamification** — `streaks`, `xp`, `habit-engagement`
- **Accounts & billing** — `user`, `billing` (Stripe webhook controller), `welcome`,
  `data-rights`, `contact-policy`
- **Infrastructure** — `session-buffer` (Redis), `burst-coalescer`, `scheduler` (pg-boss),
  `strategy-admin` (the admin API the research worker submits drafts to), `langfuse`,
  `health`, `help`, `echo`, `spoke-session`

## Commands

```bash
pnpm dev                               # nest start --watch on :3001 (from repo root: pnpm dev:bot)
pnpm test                              # jest unit specs (*.spec.ts)
pnpm test -- path/to/file.spec.ts      # single file
pnpm test -- -t "name of test"         # single test by name
pnpm test:integration                  # *.integration.ts — real Postgres/Redis/Qdrant via testcontainers (Docker required)
pnpm build                             # nest build
```

## Patterns that bite

- **Resolve config lazily, never at module-import time.** The process starts *without*
  inference/Langfuse env vars; `ConfigModule.forRoot` populates them later during bootstrap,
  after `@wabi/shared` is already imported. `getProvider(role)` re-reads `process.env` on
  every call by design; services call it from constructors. Don't cache env-derived state in
  a field or top-level const.
- **No durable transcripts (ADR-0013).** Live turns live in Redis and evaporate at session
  end; the sweeper derives Memory then deletes the key. Don't add transcript storage.
- **Gating by access tier (ADR-0011).** The DM path never creates a `User`.

## Conventions

TDD is the norm — write/extend the `*.spec.ts` alongside changes and run `pnpm test` before
claiming done. Cite the ADR in the commit when a change is shaped by a decision.

See `../../docs/ARCHITECTURE.md` and `../../docs/adr/` for the *why*.
