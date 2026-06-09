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

### Crisis detection is never payment-gated (the four-line rule)

"Crisis Escalation fires even without Active Access" (ADR-0005) means the **full two-layer detection**, not just the cheap keyword layer. A paraphrased crisis with no keyword ("I just don't see the point anymore") is only caught by the LLM classifier — and a lapsed, at-risk user is exactly who must not be missed. The resulting gate (DM path, ADR-0015):

```
tripwire      -> ALWAYS (every message, even pre-consent)
classifier    -> whenever CONSENTED (active OR lapsed)   ← safety, not paywalled
coach + store + new logging  -> ACTIVE ACCESS only
data read / export / delete  -> ALWAYS
```

> **Amendment (ADR-0026):** `new logging` above is scoped to **coaching-pipeline writes** (memory/session derivation inside the DM path). The standalone inner-state log commands (`/mood`, `/journal`, `/tilt`, `/playtime`) are deliberately **not** access-gated — logging your own state is treated as a data right, not new AI work. Only the coaching DM path gates on Active Access.

A lapsed user's free-form DM therefore runs tripwire + classifier (cost is bounded — the cheap `CLASSIFIER_MODEL`, never the coach), and on no crisis returns a **rate-limited** (once per session/day, never per message) caring resubscribe prompt. "Read-only data access" is served via the web dashboard and read-only slash commands (`/profile`, `/mood stats`), not free-form DM.

## Why

Charging for inference is necessary (ADR-0005), but a wellness companion must not weaponise a person's own mental-health history as conversion pressure. Separating "new AI work" (gated) from "your existing data and your rights" (never gated) keeps the paywall ethical.
