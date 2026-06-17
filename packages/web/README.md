# @wabi/web

The **Next.js 15 App Router** front end for Wabi. It owns everything that happens in a
browser: the landing page, Discord OAuth + consent + trial + `User` creation, Stripe
checkout, the member dashboard, and the `/admin/strategies` strategy-review surface. Sessions
are managed with **lucia**. It runs on **:3000** locally.

Web is **web-first onboarding** (ADR-0015): the browser is where a `User` is created. The
bot's DM path never creates a user — an unknown DM only gets a "finish setup" link back here.

## Onboarding flow (ADR-0015/0011)

```
landing → "Connect Discord" (OAuth: identify + email)
  → create User + consentAcceptedAt + trialEndsAt + lucia session
  → "Start talking to Wabi" → hub-server invite link
  → user joins locked-down hub → (bot) guildMemberAdd → welcome DM
```

## Layout

App Router under `src/app/`:

- `page.tsx`, `layout.tsx` — landing + root layout
- `consent/` — consent capture
- `dashboard/` — member dashboard
- `admin/strategies/` — strategy-draft review UI (proxies to the bot's admin API)
- `admin/research/` — research worker config/schedule/run UI
- `api/` — route handlers:
  - `api/auth/discord/` (+ `callback/`), `api/auth/logout/` — OAuth + sessions
  - `api/billing/checkout/`, `api/billing/portal/` — Stripe
  - `api/consent/accept/`, `api/consent/decline/` — consent persistence
  - `api/admin/strategies/[...path]/` — authenticated proxy to the bot's strategy-admin API
  - `api/admin/research/[...path]/` — authenticated proxy to the research worker's admin API
- `middleware.ts` — edge middleware

`src/lib/` holds the cross-cutting helpers: `auth.ts` / `session.ts` (lucia),
`auth-guard.ts`, `admin.ts`, `db-user.ts`, `pending-consent.ts`, `stripe.ts`.

## Commands

```bash
pnpm dev      # next dev on :3000 (from repo root: pnpm dev:web)
pnpm build    # next build
pnpm start    # next start (production)
pnpm test     # jest
```

## Notes

- `packages/web/.env` is Next.js config and is gitignored. It is **separate** from the root
  `.env` the bot reads.
- Data access goes through `@wabi/shared` (Prisma client + access resolver); web does not own
  its own schema.
- Inner-state data (mood/tilt/journal) never surfaces here — privacy by construction
  (ADR-0002).

See `../../docs/ARCHITECTURE.md` and `../../docs/adr/` for the *why*.
