# Community (deferred — out of scope for v1)

The planned guild-scoped social and gamified layer: server members, shared challenges, and leaderboards. **Deferred per ADR-0003** — Wabi v1 is a DM-first personal companion with no server dimension. This file is a placeholder so the context map's link resolves; the glossary will be filled in if and when the community layer is built.

## When this context wakes up, it must honour

- **Inner-state stays private (ADR-0002):** members, challenges, and leaderboards may read only *habit engagement* (Streak length, XP), never Mood, Tilt, or Wellness Score.
- **Person is global (ADR-0003):** personal progress belongs to the `User`; a "member" is only a person's *participation* in a guild, carrying guild role and challenge progress — no inner-state or score data.

## Likely language (not yet canonical)

- **Member** — a `User`'s participation in a specific guild. Distinct from `User`.
- **Challenge** — a time-boxed shared goal within a guild.
- **Leaderboard** — a ranking of opted-in members by non-sensitive metrics only.
