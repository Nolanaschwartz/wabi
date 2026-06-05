# Trial starts on first use; lapsed users keep read-only access and full data rights

Defines the access lifecycle behind ADR-0005 (`hasActiveAccess`, `trialEndsAt`, `subscriptionStatus`).

## Trial start

The trial begins on a person's **first real interaction** (first DM) — Wabi sets `trialEndsAt = now + TRIAL_DAYS` (default 7) and `subscriptionStatus = "trialing"`. **No card up front.** This is the lowest-friction path for a personal companion and lets someone experience it before paying.

## What a lapsed / expired user can still do

When `hasActiveAccess` is false (trial ended or subscription canceled), the person:

- **Keeps read-only access to their own data** — past Moods, Tilt history, Journal entries, streaks. Their data is never held hostage behind the paywall.
- **Can always export and delete their data** — these are rights, not features, and are never gated (reinforces ADR-0004).
- **Still trips Crisis Escalation** if they reach the bot in distress (ADR-0005).
- Sees a gentle resubscribe prompt.

**Gated** for lapsed users: *new* coaching conversations, new logging, and proactive check-ins.

## Why

Charging for inference is necessary (ADR-0005), but a wellness companion must not weaponise a person's own mental-health history as conversion pressure. Separating "new AI work" (gated) from "your existing data and your rights" (never gated) keeps the paywall ethical.
