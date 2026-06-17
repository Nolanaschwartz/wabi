# Wabi is paid-only (with a free trial); safety is never gated

Wabi has **no free tier**. LLM inference is a real per-message cost, so coaching requires an active paid **Subscription**. New users get a **time-limited free trial (~7 days)** — the only no-cost path — after which access ends unless they subscribe. There is a single tier; the former `isPro`/`isTeam` booleans are **replaced by a computed `hasActiveAccess` accessor (see `packages/shared/src/access.ts`), derived from `trialEndsAt`/`subscriptionStatus`** (true while trialing or subscribed). `isTeam` and its Team tier died with the community layer (ADR-0003).

## The one carve-out: crisis safety is never gated

If Wabi is in a conversation with someone — including a **lapsed or expired** user who still reaches the bot — and that person expresses crisis-level distress, **Crisis Escalation (ADR-0001) always fires**. The paywall may gate coaching, logging, and memory; it must never silently swallow a crisis signal. A future revenue change must not erode this.

## Why

Giving inference away free is not viable. But a mental-health-adjacent product cannot ethically let a paywall stand between a person in crisis and hotline resources. Separating "the product is paid" from "the safety net is unconditional" lets both be true.

## Consequences

- `isPro`/`isTeam` removed from the data model, replaced by a computed `hasActiveAccess` accessor in `packages/shared/src/access.ts`, derived from `subscriptionStatus` and `trialEndsAt`, meaning "active access (trial or paid)".
- Access checks must distinguish "no active access → gate coaching" from "crisis detected → escalate regardless".
