# Inner-state data never crosses into the Community context

A person's *inner state* — Mood ratings, Tilt episodes and severity, Journal entries — is private to the Wellbeing context and to that person. The Community context (members, challenges, leaderboards, Wellness Score) may only ever read *habit engagement*: the fact that a self-care action happened, never how the person felt.

Concretely, the **Wellness Score** is computed from habit consistency (check-ins answered, breaks taken, streaks held) and explicitly does **not** read Mood or Tilt. It is private by default, and leaderboards rank only opt-in, non-sensitive metrics (XP, streak length). Mood, Tilt, and the raw Wellness Score never appear on a leaderboard.

## Why

Wabi handles sensitive mental-health-adjacent signals (ADR-0001). Surfacing them socially — even indirectly via a "wellness" ranking — would turn a person's bad week into a public comparison and erode the trust the product depends on. Separating "how you feel" from "what you do" lets gamification stay motivating without ever leaking inner state.

## Amendment (2026-06-09)

"Private to the Wellbeing context and to that person" is a bound against the **Community** context — not a rule that inner state never leaves Postgres. ADR-0029 lets free-text inner state (Journal / Mood note / Tilt trigger) feed that person's *own* derived Memory (per-user `mem0_<userId>` namespace), consumed only by their own DM coaching, which is a Wellbeing surface. That stays inside this ADR's privacy boundary. It is consent-gated and off by default; see ADR-0029.
