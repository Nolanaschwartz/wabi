# Accounts & Billing

Who a person is and what they're entitled to use. Owns identity (Discord) and access (paid Subscription with trial). Source of truth for the `User`; every other context references a person by `UserId` only. Spans `packages/web` (OAuth, checkout, dashboard), `packages/bot` (entitlement checks, Stripe webhooks), and `packages/shared`.

## Language

**User**:
The global person behind a Discord account — one per human, identified by their Discord ID. The single source of truth for identity; all personal data across Wabi is keyed to the `User` and is global to them (no per-server scoping, ADR-0003).
_Avoid_: member, account, profile

**Discord Identity**:
The person's Discord account (Discord ID, username, avatar), obtained at install and via OAuth on the web app. Wabi authenticates *through* Discord; it has no separate password identity.
_Avoid_: login, credentials

**Subscription**:
A person's active paid access to Wabi via Stripe. Wabi is paid-only — there is no free tier (ADR-0005). A single tier; the former Team tier is dropped.
_Avoid_: plan, membership, Pro tier (as a noun)

**Trial**:
A time-limited (~7-day) period of full access granted to a new User at no cost — the only no-cost path. Starts at **web OAuth onboarding** ("Connect Discord"), the same step that creates the User and captures consent (no card up front), and converts to a Subscription or ends (ADR-0011, ADR-0015).
_Avoid_: free tier, demo

**Onboarding**:
The web-first flow that turns a verified Discord Identity into a consented, personalized `User` with a Trial and a session. Two beats: **consent** — OAuth → consent → the first-ever `User` create, stamped with `consentAcceptedAt` and `trialGrant`; then **Personalization** — the person gives the details that tailor coaching, stamped with `onboardingCompletedAt`, which marks Onboarding *complete* (ADR-0011, ADR-0015). The consent beat is the **only** path that creates a `User`; nothing is persisted before affirmative consent (ADR-0002). The DM path never onboards (lookup-only) and a User whose Onboarding is incomplete (`onboardingCompletedAt` null) is pointed back to the web app to finish. In `packages/web` the consent beat lives in one transport-agnostic module (`lib/onboarding.ts`); the routes are thin adapters.
_Avoid_: signup, registration, sign-in

**Personalization**:
The details a person gives during Onboarding so coaching is useful from day 1, before any derived Memory exists: their locale, timezone, the **Improvement Areas** they want to work on, and their **Interests** (games/genres/hobbies). Every field is a **controlled selection** — multi-select checklists or selects, **no free text** — so there is nothing to crisis-screen and no disclosure vector. Stored as plain `User` fields and read **directly** by the AI Coach — it is *not* derived Memory and never flows through Mem0 or the Crisis Screening spine (ADR-0029 keeps profile-shaped, structured input in Postgres rather than the extraction LLM). Completing Personalization stamps `onboardingCompletedAt`; it is re-editable from the dashboard.
_Avoid_: profile (reserved — see `User`), preferences (too generic), survey

**Interests**:
A person's chosen games, genres, and hobbies from a controlled multi-select vocabulary, captured during Personalization. Read by the AI Coach for rapport/context only — unlike **Improvement Areas**, Interests do **not** steer Strategy retrieval. Stored as slugs on the `User`.
_Avoid_: hobbies (narrower), tags

**Improvement Area**:
One item from a fixed, controlled vocabulary of things a person can choose to work on (e.g. tilt, focus, sleep). Stored as slugs on the `User`; expanded to a short phrase to bias **cold-start** Strategy retrieval — when a Conversation has no prior context yet, the chosen areas seed the strategy query so day-1 suggestions are relevant. As real Conversation accrues, the live message dominates. Never touches crisis detection.
_Avoid_: goal (free-text, distinct), topic, category

**Active Access**:
Whether a User may currently use coaching right now. **Derived on read, never stored**: `active` subscription, OR `trialing` with an unexpired Trial (`trialEndsAt > now`). `past_due`, `canceled`, and an expired Trial are all false — a `trialing` status alone does **not** grant access once the Trial date has passed. The single decision lives in `@wabi/shared` (`decideAccess`) so the bot's gate and the web dashboard agree by construction. Replaced the former `isPro`/`isTeam` (ADR-0005); the persisted `hasActiveAccess` column was dropped once access became a pure derivation.
_Avoid_: Pro status, premium flag, "the hasActiveAccess field" (no longer exists)

**Entitlement**:
What Active Access unlocks: *new* AI Coach conversations, new logging, and proactive check-ins. Crisis Escalation is **not** an entitlement — it is unconditional and fires even without Active Access (ADR-0005). Neither are Data Rights.
_Avoid_: permission, feature flag

**Data Rights**:
A person's always-available ability to **read, export, and delete their own data**, regardless of Active Access (ADR-0011, ADR-0004). A lapsed User keeps read-only access to their history; never held hostage behind the paywall. Rights, not features.
_Avoid_: GDPR features, account settings (as a synonym)

**Account read**:
A named, single-purpose read of a `User` keyed to what one caller needs — it owns its own projection and its own safe default, so a caller never threads a Prisma `select` or reads the whole row to use one column. The bot's `AccountReads` exposes them: `consentState(id)` (the facts a DM entry point needs in one read — whether the person consented, for the coaching DM gate and the welcome opener gate, plus their `timezone` for the coach prompt; shared by two callers) and `localeFor(id)` (the Crisis Resources locale, owning the `en-US` default). Distinct from the **full-row** read **Active Access** requires: `decideAccess` needs the entire subscription shape, so it stays a whole-`User` read. Account reads **fail safe** — a failed read resolves to the safe default (not consented, `en-US`), never throws (ADR-0011/0021).
_Avoid_: user lookup, getUser (too generic — names the table, not the intent)

## Example dialogue

> **Dev:** A user's trial expired yesterday and they just DM'd Wabi "I lost again, I'm done with everything." Do we reply or show a paywall?
> **Domain expert:** Both layers run. They have no Active Access, so coaching is gated — normally that's a "your trial ended, resubscribe" message. But "I'm done with everything" trips Crisis Escalation, which is not an Entitlement. Safety fires first: surface crisis resources, *then* the gating message. We never let the paywall swallow that signal.
