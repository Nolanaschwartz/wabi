# Web Onboarding Profile — Design

**Date:** 2026-06-29
**Branch:** `Nolanaschwartz/user-onboarding`
**Status:** Approved design, pre-implementation

## Problem

Wabi must be useful on day 1, before the per-user Mem0/neo4j memory is populated. The
coach today reads only `timezone` plus whatever Mem0 recall and Qdrant strategy retrieval
surface from the live message — so a brand-new user gets generic coaching and cold-start
strategy fetches. We collect a small profile during web onboarding (locale, timezone,
improvement areas, goals, interests) to seed both the user memory and strategy retrieval,
and we hard-gate bot coaching until that profile exists.

## Goals

- Collect a minimal profile on the web app immediately after consent.
- Seed the user's Mem0 memory at submit so the coach recalls the person from their first DM.
- Let stated **improvement areas** bias **cold-start** strategy retrieval (the day-1 payoff).
- Hard-gate bot coaching for consented users who haven't completed onboarding — without
  ever gating crisis safety.

## Non-goals

- No multi-step wizard (single page).
- No new Qdrant tag/category schema (retrieval stays embedding-only).
- No backfill/grandfathering of existing consented users — they onboard on next visit.
- Goals/interests are not relational columns (see Data Model).

## Existing context this builds on

- **Onboarding flow:** `packages/web/src/lib/onboarding.ts` is the transport-agnostic "brain"
  (OAuth callback → pending-consent token → `provisionConsentedUser` creates the first `User`
  with a trial). Routes are thin adapters; the store is reached through an injected
  `OnboardingWriter` seam, unit-tested with an in-memory double. **We mirror this pattern.**
- **Post-auth flow today:** `consent → dashboard`. `dashboard/page.tsx` is a server component
  that already redirects (`!user → /api/auth/discord`).
- **Coach context:** `coaching.service.ts` resolves access (`access`, `consented`, `timezone`)
  from the `User` row via the access resolver, then runs classify + strategy search + decision
  in parallel. Strategy retrieval (`strategy-retrieval.service.ts:search`) is **pure embedding
  search over a query string**, re-ranked by evidence tier/confidence — no tag filtering.
- **Memory write:** `deriveAndStore(userId, sessionText)` is exported from `@wabi/shared`
  (the bot's `memory-store.service` imports it from there). Web can import it directly.
- **Setup link:** `packages/bot/src/lib/setup-link.ts` `setupLinkMessage(baseUrl)` is the single
  source of the "finish setup" prompt for unconsented DMs.
- **Crisis tripwire:** zero-dependency `crisisTripwire` runs on every DM before anything else
  (ADR-0021); the "no unscreened free-text → memory" invariant (ADR-0028/0031) routes all
  DM free-text→memory writes through a screened spine.

## Data model

In `packages/shared/prisma/schema.prisma`, add to `User`:

```prisma
improveAreas          String[]  @default([])   // controlled checklist slugs
onboardingCompletedAt DateTime?                 // gate signal; null = not onboarded
```

`locale` and `timezone` already exist on `User`. **Goals and interests are not columns** — they
are free-text that only matters as recall flavor, so they are seeded into Mem0 at submit and not
stored relationally. (If they ever need to be re-editable, add columns then — YAGNI now.)

Run `db:migrate:dev` from `packages/shared` to create the migration, then `db:generate`.
Rebuild `@wabi/shared` dist so the bot's jest sees the regenerated client.

### Improvement-areas vocabulary (controlled)

Stored as slugs; expanded to a short phrase for the retrieval query embedding:

| slug | query phrase |
|------|--------------|
| `tilt` | managing tilt and frustration while gaming |
| `focus` | improving focus and concentration |
| `sleep` | better sleep and rest |
| `social-connection` | building social connection and reducing loneliness |
| `burnout` | recovering from burnout |
| `motivation` | finding motivation |
| `screen-time-balance` | balancing screen time and other parts of life |
| `confidence` | building confidence |
| `stress` | managing stress |

The slug→phrase map lives in `@wabi/shared` so both the web checklist labels and the bot's
query augmentation reference one source.

## Flow

```
OAuth → consent → /onboarding → dashboard
                       ↑
        dashboard redirects here while onboardingCompletedAt is null
```

The dashboard server component gains a redirect: `if (!user.onboardingCompletedAt) redirect('/onboarding')`,
placed beside the existing `!user` redirect.

## Components

### 1. `completeOnboarding()` brain — `packages/web/src/lib/onboarding-profile.ts`

Transport-agnostic, mirroring `onboarding.ts`. Signature shape:

```ts
interface ProfileWriter {
  user: { update(args: { where: { id: string }; data: {
    locale: string; timezone: string; improveAreas: string[]; onboardingCompletedAt: Date;
  }}): Promise<{ discordId: string }> };
}
type ProfileInput = {
  locale: string; timezone: string; improveAreas: string[];
  goals: string; interests: string;
};
async function completeOnboarding(
  db: ProfileWriter,
  userId: string,
  input: ProfileInput,
  now: Date,
  seed: (discordId: string, text: string) => Promise<void>,   // injected deriveAndStore
  screen: (text: string) => boolean,                          // injected crisisTripwire (true = trips)
): Promise<{ ok: true; seeded: boolean } | { ok: 'crisis' }>
```

Behavior:
1. Validate `improveAreas` against the controlled vocabulary (drop unknown slugs); clamp
   goals/interests length.
2. Build the seed prose from goals + interests + improvement-area phrases.
3. **Screen the free-text:** if `screen(goalsAndInterestsText)` trips → write the structured
   columns (locale/timezone/improveAreas) and stamp `onboardingCompletedAt`, but **skip the
   Mem0 seed**, and return `{ ok: 'crisis' }` so the route renders the crisis-resources block.
   (Onboarding still completes — the gate clears — we just don't seed flagged text.)
4. Otherwise write columns + stamp timestamp, then `seed(discordId, prose)`. Mem0 failure is
   non-fatal (log + continue); onboarding still completes. Return `{ ok: true, seeded }`.

The structured write and the timestamp happen in **one** Prisma `update`. The Mem0 seed is a
separate best-effort call after the row is committed.

### 2. `/onboarding` page — `packages/web/src/app/onboarding/page.tsx`

Server component guards (`!user → /api/auth/discord`; already-onboarded users reaching the page
directly are allowed so it doubles as the settings editor — prefilled). Renders a client form:

- **Timezone / locale:** prefilled from `Intl.DateTimeFormat().resolvedOptions().timeZone` and
  `navigator.language` on mount, both editable (`<select>` / native input — no picker lib).
- **Improvement areas:** checklist of the controlled vocabulary labels.
- **Goals / interests:** two free-text `<textarea>`s (optional, length-capped).
- Submit → `POST /api/onboarding`. On `{ ok: 'crisis' }` render the shared crisis-resources block
  (reuse the consent page's resource copy) instead of redirecting; on `{ ok: true }` → `/dashboard`.

### 3. Route — `packages/web/src/app/api/onboarding/route.ts`

Thin adapter: validate session (`validateRequest`), parse body, call `completeOnboarding(prisma,
user.id, input, new Date(), deriveAndStore, crisisTripwire)`, return JSON. `deriveAndStore` and
`crisisTripwire` imported from `@wabi/shared`.

### 4. Settings entry — dashboard

Add a "Edit your profile" link on the dashboard pointing at `/onboarding`. Same page, prefilled
from the `User` row + (goals/interests are not stored, so those textareas start empty on edit —
acceptable; re-submitting re-seeds Mem0). No new route.

### 5. Bot hard gate — coaching path

In the coaching path, after `crisisTripwire` and alongside the active-access check: if the
resolved `User` has `onboardingCompletedAt == null`, reply with a new
`finishOnboardingMessage(baseUrl)` (sibling of `setupLinkMessage` in `setup-link.ts`, pointing at
`/onboarding`) and **return without coaching**. The access resolver already loads the `User` row,
so it exposes `onboardingCompletedAt` to the coach with no extra query — extend its returned shape.

**Crisis is never gated:** `crisisTripwire` and the crisis flow run before this check, exactly as
they do for the unconsented path. An un-onboarded user in crisis still gets the crisis flow.

### 6. Improvement areas → cold-start strategy retrieval — `coaching.service.ts`

When the session buffer is **cold** (no/thin prior context for this user), augment the strategy
retrieval query string with the improvement-area phrases (from the shared slug→phrase map) before
it is embedded. When the buffer is warm, use the live message unchanged. Single string
concatenation at the retrieval call site; no change to `strategy-retrieval.service.ts`.

"Cold" = the existing `sessionBuffer.getContext(userId)` returns empty/below a small threshold.

## Data flow (submit)

```
client form ─POST─▶ /api/onboarding
                        │ validateRequest → userId
                        ▼
                 completeOnboarding(prisma, userId, input, now, deriveAndStore, crisisTripwire)
                        │
          ┌─────────────┴─────────────┐
   screen trips?                    no trip
          │                           │
  update columns+stamp,        update columns+stamp
  SKIP seed, return crisis     deriveAndStore(seed prose)  ──▶ Mem0
          │                           │
          ▼                           ▼
   render resources            redirect /dashboard
```

## Error handling

- **Missing/invalid session** → 401, no write (route guard).
- **Unknown improvement slugs** → silently dropped (validated against vocabulary).
- **Mem0 seed failure** → logged, non-fatal; onboarding still completes (gate clears). Day-1
  recall degrades to empty, which is the pre-feature baseline.
- **Crisis tripwire trips on free-text** → structured profile still saved + gate cleared, Mem0 seed
  skipped, crisis resources shown.
- **Replayed/duplicate submit** (already onboarded) → idempotent: re-writes columns, re-seeds Mem0,
  `onboardingCompletedAt` stays set. No trial/billing fields touched.

## Migration / rollout

Existing consented users have `onboardingCompletedAt == null`, so on next dashboard visit they're
redirected to `/onboarding` and the bot hard-gates their coaching until they finish. No backfill —
collecting their profile is the point. Trivial at current scale.

## Testing

- **`completeOnboarding()`** (unit, injected `ProfileWriter` + `seed` + `screen` doubles):
  - writes columns + stamps `onboardingCompletedAt`, calls `seed` with prose containing goals/interests/area phrases.
  - tripwire trips → columns written, `onboardingCompletedAt` stamped, `seed` NOT called, returns `{ ok: 'crisis' }`.
  - unknown improvement slugs dropped; goals/interests length-clamped.
  - `seed` rejection is swallowed → still `{ ok: true, seeded: false }`.
- **Dashboard redirect:** `onboardingCompletedAt == null → redirect('/onboarding')`.
- **Bot gate spec:** null → `finishOnboardingMessage`, no coach call; non-null → normal coaching;
  crisis input with null still routes to crisis (safety not gated).
- **Coaching retrieval:** cold buffer + `improveAreas` → retrieval query includes area phrases;
  warm buffer → query is the live message only.

## Files touched

- `packages/shared/prisma/schema.prisma` — two `User` fields + migration.
- `packages/shared/src/…` — improvement-area slug→phrase map export.
- `packages/web/src/lib/onboarding-profile.ts` — `completeOnboarding` brain (+ test).
- `packages/web/src/app/onboarding/page.tsx` + client form.
- `packages/web/src/app/api/onboarding/route.ts`.
- `packages/web/src/app/dashboard/page.tsx` — redirect-while-null + settings link.
- `packages/bot/src/lib/setup-link.ts` — `finishOnboardingMessage`.
- `packages/bot/src/modules/billing/access-resolver.ts` — expose `onboardingCompletedAt`.
- `packages/bot/src/modules/coaching/coaching.service.ts` — gate + cold-start query augmentation.
- Bot specs alongside the above.
