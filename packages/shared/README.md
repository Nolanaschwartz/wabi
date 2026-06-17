# @wabi/shared

Plain TypeScript shared by `@wabi/bot`, `@wabi/web`, and `@wabi/research`. It owns the
**Prisma client + generated types**, the **swappable-provider** and **access** resolvers, and
a handful of constants. It is the single point of contact with the database schema — no other
package owns Prisma models.

Built with `tsc` to `dist/`; consumers import the compiled output.

## What's inside (`src/`)

- **`prisma.ts`** — the Prisma client singleton.
- **`provider.ts`** — `getProvider(role)`, the per-role swappable inference resolver (ADR-0009).
  It **re-reads `process.env` on every call by design** so that config resolved late during
  the bot's bootstrap is honoured. Never cache its result in a field or top-level const.
  Roles include `coach` / `classifier` / `embedding` (and the research worker's
  `research` / `research-triage`).
- **`access.ts`** — the access resolver: `hasActiveAccess = (now < trialEndsAt) OR
  stripeStatus ∈ {active, trialing}` (ADR-0011). The source of truth for entitlement,
  derived on read.
- **`sentry-scrub.ts`** — content-scrubbing for error reporting, exported as a separate entry
  point (`@wabi/shared/sentry-scrub`).
- **`index.ts`** — the public barrel.

## Prisma

The schema and migrations live here under `prisma/`.

```bash
pnpm db:generate      # prisma generate — regenerate the client after schema edits
pnpm db:push          # prisma db push (also exposed as `pnpm db:push` from the repo root)
pnpm db:migrate:dev   # prisma migrate dev — create + apply a migration
pnpm db:migrate       # prisma migrate deploy
pnpm db:studio        # prisma studio
```

**Env trap:** `packages/shared/.env` must contain **only `DATABASE_URL`**. Prisma auto-loads
it at import time, *before* the bot's `ConfigModule` runs, and dotenv never overrides an
already-set var — so anything else placed here silently shadows the root `.env`.

## Commands

```bash
pnpm build   # tsc → dist/
pnpm test    # jest
```

Postgres is the **only authoritative, non-rebuildable store** (ADR-0004/0009). See
`../../docs/ARCHITECTURE.md` for the full data-store map.
