# Context Map

Wabi is a non-clinical wellness companion for gamers on Discord, delivered **DM-first** as a private 1:1 personal companion (see `docs/adr/0001-non-clinical-positioning.md` and `docs/adr/0003-dm-first-companion.md`). Its domain splits into three contexts. These are **language boundaries**, not deployment boundaries — they do not map 1:1 onto the `bot` / `web` / `shared` packages.

## Contexts

- [Wellbeing](./docs/contexts/wellbeing/CONTEXT.md) — one person's inner state and habits: mood, tilt, playtime, journaling, and the AI coach that reflects on them. The heart of v1. Lives mostly in `packages/bot`.
- [Accounts & Billing](./docs/contexts/accounts/CONTEXT.md) — who a person is and what they've paid for: Discord identity, OAuth, subscription entitlement, Stripe. Spans `packages/web`, `packages/bot`, `packages/shared`.
- [Community](./docs/contexts/community/CONTEXT.md) — **deferred, out of scope for v1** (ADR-0003). The planned guild-scoped social/gamified layer: members, challenges, leaderboards. Streaks/XP and Wellness Score belong to the person (Wellbeing/Accounts), not the server. Kept here as a dormant, planned area.

## Relationships

- **Accounts → Wellbeing**: Accounts owns the `User` and is the source of truth for identity (`UserId`, Discord ID) and entitlement (Active Access, derived on read via `@wabi/shared`). Wellbeing references a person by `UserId` only. All personal data is global to the `User` — there is no per-server scoping in v1.
- **Crisis escalation** (ADR-0001) is owned by Wellbeing (the AI coach) and is cross-cutting: it overrides all coaching behaviour.
- **Inner-state privacy** (ADR-0002): inner-state data (Mood, Tilt, Journal) never crosses into a social surface. Trivially satisfied in DM-first v1; binding if/when the Community layer lands.

## ADRs

- System-wide decisions: `docs/adr/`
- Context-specific decisions: `docs/contexts/<context>/adr/`
