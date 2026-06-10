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

**Active Access**:
Whether a User may currently use coaching right now. **Derived on read, never stored**: `active` subscription, OR `trialing` with an unexpired Trial (`trialEndsAt > now`). `past_due`, `canceled`, and an expired Trial are all false — a `trialing` status alone does **not** grant access once the Trial date has passed. The single decision lives in `@wabi/shared` (`decideAccess`) so the bot's gate and the web dashboard agree by construction. Replaced the former `isPro`/`isTeam` (ADR-0005); the persisted `hasActiveAccess` column was dropped once access became a pure derivation.
_Avoid_: Pro status, premium flag, "the hasActiveAccess field" (no longer exists)

**Entitlement**:
What Active Access unlocks: *new* AI Coach conversations, new logging, and proactive check-ins. Crisis Escalation is **not** an entitlement — it is unconditional and fires even without Active Access (ADR-0005). Neither are Data Rights.
_Avoid_: permission, feature flag

**Data Rights**:
A person's always-available ability to **read, export, and delete their own data**, regardless of Active Access (ADR-0011, ADR-0004). A lapsed User keeps read-only access to their history; never held hostage behind the paywall. Rights, not features.
_Avoid_: GDPR features, account settings (as a synonym)

## Example dialogue

> **Dev:** A user's trial expired yesterday and they just DM'd Wabi "I lost again, I'm done with everything." Do we reply or show a paywall?
> **Domain expert:** Both layers run. They have no Active Access, so coaching is gated — normally that's a "your trial ended, resubscribe" message. But "I'm done with everything" trips Crisis Escalation, which is not an Entitlement. Safety fires first: surface crisis resources, *then* the gating message. We never let the paywall swallow that signal.
