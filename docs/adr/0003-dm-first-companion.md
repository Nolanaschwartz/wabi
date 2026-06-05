# Wabi is a DM-first personal companion; the server/community layer is deferred

Wabi's core experience is a private 1:1 conversation in a person's Discord **DMs**. Everything a person tracks — Mood, Tilt, Playtime, Journal, Streaks, XP, Wellness Score — is private to them and **global to their `User`**; there is no per-server scoping.

The guild/community layer in the original plan (`CommunityMember`, per-server challenges, leaderboards, the Stripe **Team** tier) is **deferred and out of scope for v1**. The `Community` context is kept in the context map as a planned-but-dormant area.

## Why

The product is fundamentally about supporting an individual, privately. Leading with DMs keeps inner-state data away from any social surface by construction (reinforcing ADR-0002), removes the per-server identity-scoping question entirely for v1, and lets the build focus on the personal companion before any community mechanics.

## Consequences

- v1 drops Phase 7 community work (Task 17 challenges/leaderboards) and the per-guild `CommunityMember` model.
- ADR-0002 (inner-state stays private) is satisfied trivially in v1 — there is no community surface — but remains binding when the server layer lands.
- The data model is single-scope: all personal data keyed by `User`, no `guildId`.

> **Amendment (ADR-0015):** the *delivery mechanism* changed. "DM-first" stands, but Wabi is **not** a user-installable interactions-only app — it is a **classic bot** reached via a shared **hub server**, because only that model can read free-form DMs (required by the coaching pipeline and the always-on crisis tripwire). The "no shared server required" claim is retracted; the invite URL changes from `integration_type=1` to a `scope=bot applications.commands` install.
