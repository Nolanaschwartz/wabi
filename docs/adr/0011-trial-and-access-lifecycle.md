# Trial starts on first use; lapsed users keep read-only access and full data rights

Defines the access lifecycle behind ADR-0005 (`hasActiveAccess`, `trialEndsAt`, `subscriptionStatus`).

## Trial start

The trial begins at **web OAuth onboarding** ("Connect Discord") — the same step that creates the `User` and captures consent (ADR-0015). Wabi sets `trialEndsAt = now + TRIAL_DAYS` (default 7) and `subscriptionStatus = "trialing"`. **No card up front.** The trial is still free and still precedes any payment; it simply starts at OAuth rather than at the first DM.

> **Amendment (ADR-0015):** the trigger moved from "first DM interaction" to "OAuth onboarding," because consent is captured web-first and the DM path is now lookup-only (it must never create a `User`). `startTrialIfNew` lives in the OAuth callback, not in `messageCreate`/`logMood`. An un-onboarded DM gets the crisis tripwire plus a "finish setup" link — never a `User` upsert, never coaching.

## What a lapsed / expired user can still do

When `hasActiveAccess` is false (trial ended or subscription canceled), the person:

- **Keeps read-only access to their own data** — past Moods, Tilt history, Journal entries, streaks. Their data is never held hostage behind the paywall.
- **Can always export and delete their data** — these are rights, not features, and are never gated (reinforces ADR-0004).
- **Still trips Crisis Escalation** if they reach the bot in distress (ADR-0005).
- Sees a gentle resubscribe prompt.

**Gated** for lapsed users: *new* coaching conversations, new logging, and proactive check-ins.

## Why

Charging for inference is necessary (ADR-0005), but a wellness companion must not weaponise a person's own mental-health history as conversion pressure. Separating "new AI work" (gated) from "your existing data and your rights" (never gated) keeps the paywall ethical.
