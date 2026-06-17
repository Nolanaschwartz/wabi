# Wabi

A **DM-first, non-clinical wellness companion for gamers on Discord**. A person talks to
Wabi in their Discord DMs like a friend; it coaches them using memory and evidence-based
strategies, behind a hard crisis-safety boundary that overrides all other behaviour. v1 is
single-process and always-on.

> **Not a clinical or crisis service.** Wabi is a wellness companion (ADR-0001). It detects
> crisis language and surfaces local resources, but it never diagnoses, treats, or replaces
> professional or emergency care.

## How it works

A DM arrives → a zero-dependency **crisis tripwire** runs first → the person is looked up
and gated by access tier → a fast **classifier** screens for crisis while **retrieval**
gathers memory + strategies in parallel → if safe, the **coach** replies with a single
message and the turn is buffered in Redis. Later a background sweeper derives durable
*Memory* from the session and deletes the buffer. Verbatim DMs are never persisted.

See `docs/ARCHITECTURE.md` for the full hot path, deployment topology, and personal-data
map.

## Monorepo layout

pnpm workspace; packages live under `packages/*` (there is no `apps/`). Each package has its
own README.

| Package | What it is |
|---|---|
| [`@wabi/bot`](packages/bot) | NestJS + necord over discord.js. The heart: Discord gateway, crisis→coaching pipeline, Stripe webhook, pg-boss worker/scheduler. Always-on. |
| [`@wabi/web`](packages/web) | Next.js 15 App Router. Landing, Discord OAuth + consent + trial + `User` creation, Stripe checkout, dashboard, `/admin/strategies` review. |
| [`@wabi/shared`](packages/shared) | Plain TypeScript: Prisma client + generated types, constants, swappable-provider + access resolvers. Imported by the others. |
| [`@wabi/research`](packages/research) | Always-on NestJS service (:3002, ADR-0034). Mines PubMed/medRxiv for evidence-based techniques and submits `StrategyDraft`s to the bot for human review. |

## Quick start

Package manager is **pnpm**. Run from the repo root unless noted.

```bash
pnpm install                                   # install workspace deps
docker compose up -d postgres redis qdrant mem0   # local infra (also: neo4j, glitchtip)
cp .env.example .env                           # then fill in secrets — see .env.example
pnpm db:push                                   # push the Prisma schema
pnpm dev                                       # all packages in parallel (web :3000, bot :3001)
```

The bot comes online even if infra is down (degraded) so the Discord gateway never blocks.

### Common commands

```bash
pnpm dev            # all packages in parallel (excludes community)
pnpm dev:bot        # bot only (nest --watch, binds :3001)
pnpm dev:web        # web only (next dev, owns :3000)
pnpm build          # build all packages
pnpm test           # run every package's tests
pnpm db:push        # prisma db push  (delegates to @wabi/shared)
pnpm db:generate    # prisma generate (regenerate client after schema edits)
```

### Env-file traps

- Root `.env` is the canonical app config the **bot** reads; `.env.example` documents every var.
- `packages/shared/.env` must contain **only `DATABASE_URL`** — Prisma auto-loads it before the
  bot's `ConfigModule`, and dotenv never overrides an already-set var, so anything else there
  silently shadows the root `.env`.
- `packages/web/.env` is Next.js config. All `.env` files are gitignored.

## Data stores (ADR-0009 — self-hosted, swappable)

Postgres (Prisma, the only authoritative store) · Redis (ephemeral session buffer, persistence
OFF) · Qdrant (strategy + personal vectors, 768-dim) · Mem0 (derived memory, hybrid
Qdrant+neo4j) · neo4j (per-user graph) · local bge embeddings · Langfuse (traces) · GlitchTip
(errors). All run via `docker-compose.yml` for local dev.

## Cross-cutting posture

- **Safety fails closed** (ADR-0021) — no classifier means no coaching; the crisis path is the
  highest-stakes code in the repo.
- **Privacy by construction** (ADR-0002/0013/0017) — inner-state data never reaches a social
  surface, personal embeddings stay on local inference, and no verbatim transcript is ever stored.
- **Gating by access tier** (ADR-0011) — tripwire always · classifier when consented · coach +
  store only on active access · data read/export/delete always.

## Documentation

These are the source of truth. **ADRs win where docs disagree.**

- `docs/ARCHITECTURE.md` — consolidated system design, key flows, personal-data map.
- `docs/adr/` — the *why* behind every structural decision (0001–0035).
- `CONTEXT-MAP.md` → `docs/contexts/<context>/CONTEXT.md` — domain vocabulary. Contexts
  (Wellbeing / Accounts & Billing / Community) are **language boundaries, not packages**.
- `CLAUDE.md` — working conventions and the patterns that bite.

The issue tracker is local markdown under `.scratch/<feature>/`, not GitHub Issues.
