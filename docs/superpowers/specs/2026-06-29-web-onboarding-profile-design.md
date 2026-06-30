# Web Onboarding Personalization — Design

**Date:** 2026-06-29
**Branch:** `Nolanaschwartz/user-onboarding`
**Status:** Approved design (grilled against ADRs), pre-implementation
**ADR:** 0044 (onboarding-incomplete coaching gates at the consent tier)
**Glossary:** `docs/contexts/accounts/CONTEXT.md` — *Onboarding* (amended), *Personalization*, *Improvement Area*, *Interests*

## Problem

Wabi must be useful on day 1, before the per-user derived Memory (Mem0/neo4j) is populated.
The coach today reads only `timezone` plus whatever Memory recall and Qdrant strategy
retrieval surface from the live message — so a brand-new user gets generic coaching and
cold-start strategy fetches. We collect a small **Personalization** during web Onboarding
and read it directly so coaching is tailored from the first DM, and we hard-gate bot
coaching until Onboarding is complete.

## Key decisions (resolved during grilling)

1. **Read-direct, not Memory.** Personalization is stored as plain `User` columns and read
   directly by the coach. It does **not** go through Mem0/`deriveAndStore` or the Crisis
   Screening spine. This aligns with ADR-0029 (profile-shaped/structured input stays in
   Postgres, not the extraction LLM) and avoids the ADR-0031 `Screened<T>` bypass that a
   web-side `deriveAndStore` would be.
2. **All controlled vocabulary, no free text.** Every field is a select/checklist, so there
   is nothing to crisis-screen and no disclosure vector. (This dissolved the earlier
   tripwire-in-web question entirely.)
3. **Two checklists.** *Improvement Areas* (multi-select) + *Interests* (multi-select).
   "Goals" was dropped as redundant with Areas.
4. **Bot is the only hard gate.** Web *nudges* (no hard dashboard redirect) so billing and
   Data Rights stay always-available (ADR-0011/0004). The bot refuses coaching until
   `onboardingCompletedAt` is set.
5. **Gate early, tripwire-only (ADR-0044).** The bot gate fires at the consent tier, before
   the classifier; un-onboarded users get the always-on tripwire floor but not the nuanced
   classifier until they finish. Deliberate; see ADR-0044.
6. **≥1 Improvement Area required to complete.** Interests optional.

## Data model

In `packages/shared/prisma/schema.prisma`, add to `User`:

```prisma
improveAreas          String[]  @default([])   // Improvement Area slugs (≥1 to complete)
interests             String[]  @default([])   // Interest slugs (optional)
onboardingCompletedAt DateTime?                 // marks Onboarding complete; null = incomplete
```

`locale` and `timezone` already exist and are (re)written by Personalization.

Run `db:migrate:dev` (from `packages/shared`), then `db:generate`, then rebuild the
`@wabi/shared` dist so the bot's jest sees the new client.

### Controlled vocabularies (`@wabi/shared`)

One module is the single source for web labels, the coach prompt, and retrieval augmentation.

**Improvement Areas** — slug → query phrase (phrase used for retrieval + prompt):

| slug | phrase |
|------|--------|
| `tilt` | managing tilt and frustration while gaming |
| `focus` | improving focus and concentration |
| `sleep` | better sleep and rest |
| `social-connection` | building social connection and reducing loneliness |
| `burnout` | recovering from burnout |
| `motivation` | finding motivation |
| `screen-time-balance` | balancing screen time and other parts of life |
| `confidence` | building confidence |
| `stress` | managing stress |

**Interests** — slug → label (label used for the coach prompt only; *not* retrieval):
`fps`, `moba`, `rpg`, `ranked-grind`, `streaming`, `speedrunning`, `music`, `fitness`,
`co-op-with-friends`, `single-player-story`. (Adjustable — product taste.)

Helpers: `expandAreas(slugs)` → phrases; `interestLabels(slugs)` → labels.

## Flow

```
OAuth → consent (creates User + Trial) → /onboarding → dashboard
```

- `consent/page.tsx` accept handler pushes to `/onboarding` (today it pushes `/dashboard`).
- `/onboarding` submit → `/dashboard`.
- Dashboard with `onboardingCompletedAt` null is **not** redirected — it renders normally
  with a prominent "Finish personalizing Wabi" card. Billing + Data Rights stay reachable.

## Components

### 1. `completeOnboarding()` brain — `packages/web/src/lib/onboarding-profile.ts`

Transport-agnostic, mirroring `onboarding.ts`. No Mem0, no screening (controlled vocab only).

```ts
interface ProfileWriter {
  user: { update(args: { where: { id: string }; data: {
    locale: string; timezone: string; improveAreas: string[]; interests: string[];
    onboardingCompletedAt: Date;
  }}): Promise<{ id: string }> };
}
type ProfileInput = { locale: string; timezone: string; improveAreas: string[]; interests: string[] };

async function completeOnboarding(
  db: ProfileWriter, userId: string, input: ProfileInput, now: Date,
): Promise<{ ok: true } | { ok: 'invalid'; reason: string }>
```

Behavior:
1. Validate `improveAreas`/`interests` against the controlled vocab (drop unknown slugs).
2. **Require ≥1 valid Improvement Area** — else `{ ok: 'invalid' }`, no write.
3. One Prisma `update`: write `locale`, `timezone`, `improveAreas`, `interests`, stamp
   `onboardingCompletedAt`. Return `{ ok: true }`.

Idempotent: re-submitting (settings edit) rewrites columns; `onboardingCompletedAt` stays
set; billing/trial fields never touched.

### 2. `/onboarding` page — `packages/web/src/app/onboarding/page.tsx`

Server component guards (`!user → /api/auth/discord`); already-onboarded users may reach it
directly so it doubles as the settings editor (prefilled from the row). Client form:
- timezone/locale prefilled from `Intl.DateTimeFormat().resolvedOptions().timeZone` and
  `navigator.language`, both editable (native `<select>` — no picker lib).
- Improvement Areas checklist (≥1 required; submit disabled until one is picked).
- Interests checklist (optional).
- Submit → `POST /api/onboarding`; on `{ ok: true }` → `/dashboard`.

### 3. Route — `packages/web/src/app/api/onboarding/route.ts`

Thin adapter: `validateRequest` → parse body → `completeOnboarding(prisma, user.id, input, new Date())` → JSON.

### 4. Dashboard — `packages/web/src/app/dashboard/page.tsx` + view

- No redirect for null onboarding. Pass an `onboardingComplete` boolean to the view.
- View renders a "Finish personalizing Wabi" card (links to `/onboarding`) when incomplete,
  and an "Edit your personalization" link (same route) when complete.

### 5. Bot hard gate — `coaching.service.ts` (consent tier) + `setup-link.ts`

- `AccessResolver.resolveAccount` (already a whole-`User` read for `decideAccess`) returns
  `onboardingCompleted: boolean` — no extra query.
- In `coaching.service`, at the consent tier (right after the unconsented → `setupLinkMessage`
  branch, **before** the `classify ∥ strategy ∥ prepare` block): if consented but
  `!onboardingCompleted`, reply with new `finishOnboardingMessage(baseUrl)` (sibling of
  `setupLinkMessage`, pointing at `/onboarding`) and return.
- Per ADR-0044 this means un-onboarded users get tripwire-only crisis screening (the
  always-on floor still runs upstream). The welcome opener stays consent-only.

### 6. Cold-start strategy retrieval — `coaching.service.ts`

When the session buffer is cold (empty/below a small threshold via the existing
`sessionBuffer.getContext`), augment the strategy-retrieval query string with
`expandAreas(user.improveAreas)` before it is embedded. Warm buffer → live message
unchanged. Single concatenation at the call site; `strategy-retrieval.service` unchanged.
(Only un-onboarded users are gated out, so this only ever runs for onboarded users — their
`improveAreas` is non-empty by the ≥1 rule.)

### 7. Coach reads Personalization — `coach-prompt.ts` + `coach-handler.ts`

- `buildCoachPrompt` gains `personalization?: { areas: string[]; interests: string[] }` (slugs)
  and renders one labeled block: `What this person told us at signup:` — "wants to work on
  {area phrases}" and, if any, "enjoys {interest labels}". Pure function, no I/O.
- Extend `READBACK_GUARD` to also name this heading (defense-in-depth; the content is our own
  controlled phrases, so it carries no injection vector — but label it consistently).
- `coach-handler` threads the slugs through the dispatch context like `timezone`.

## Error handling

- Missing/invalid session → 401, no write (route guard).
- Zero valid Improvement Areas → `{ ok: 'invalid' }`, no write; form shows the requirement.
- Unknown slugs → silently dropped (validated against vocab).
- Replayed/duplicate submit (settings edit) → idempotent; trial/billing untouched.

## Migration / rollout

Existing consented users have `onboardingCompletedAt == null`, so on next dashboard visit
they see the "finish personalizing" card and the bot hard-gates their coaching until they
finish. No backfill — collecting their Personalization is the point.

## Testing (all four modules confirmed)

Tests assert external behavior through public interfaces, not internals. Prior art:
`packages/web/src/lib/__tests__/onboarding.test.ts` (in-memory writer double); bot
`__tests__/*.spec.ts` (mock collaborators, assert outbound messages).

- **`completeOnboarding()`** (injected `ProfileWriter` double):
  - writes locale/tz/areas/interests and stamps `onboardingCompletedAt`.
  - zero valid areas → `{ ok: 'invalid' }`, no write.
  - unknown slugs dropped; valid subset persisted.
  - billing/trial fields never written; re-submit idempotent.
- **Bot coaching hard gate:** consented + `!onboardingCompleted` → `finishOnboardingMessage`,
  no classifier/strategy/coach call; onboarded → normal coaching; an explicit-crisis message
  from an un-onboarded user still trips the upstream tripwire and escalates (safety floor
  intact per ADR-0044).
- **Cold-start retrieval augmentation:** cold buffer + `improveAreas` → retrieval query
  includes the area phrases; warm buffer → live message only.
- **Dashboard:** renders the "finish personalizing" card while `onboardingCompletedAt` is
  null and does **not** redirect (billing/Data Rights reachable); shows edit link when set.

## Files touched

- `packages/shared/prisma/schema.prisma` — three `User` fields + migration.
- `packages/shared/src/…` — Improvement Area + Interest vocab module (`expandAreas`, `interestLabels`).
- `packages/web/src/lib/onboarding-profile.ts` — `completeOnboarding` brain (+ test).
- `packages/web/src/app/onboarding/page.tsx` + client form.
- `packages/web/src/app/api/onboarding/route.ts`.
- `packages/web/src/app/consent/page.tsx` — accept pushes to `/onboarding`.
- `packages/web/src/app/dashboard/page.tsx` + `dashboard-view.tsx` — nudge card, no redirect.
- `packages/bot/src/lib/setup-link.ts` — `finishOnboardingMessage`.
- `packages/bot/src/modules/billing/access-resolver.ts` — expose `onboardingCompleted`.
- `packages/bot/src/modules/coaching/coaching.service.ts` — consent-tier gate + cold-start augmentation.
- `packages/bot/src/modules/coaching/coach-prompt.ts` + `coach-handler.ts` — Personalization block.
- Specs alongside the above.

## Out of scope

- Multi-step wizard; Qdrant tag schema; Mem0 seeding; storing free text; backfilling existing
  users; wiring `checkInsEnabled`/`quietHours*`/`innerStateMemoryEnabled` into this form;
  the welcome opener nudging un-onboarded users.
