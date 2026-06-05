# Inner-state data never crosses into the Community context

A person's *inner state* — Mood ratings, Tilt episodes and severity, Journal entries — is private to the Wellbeing context and to that person. The Community context (members, challenges, leaderboards, Wellness Score) may only ever read *habit engagement*: the fact that a self-care action happened, never how the person felt.

Concretely, the **Wellness Score** is computed from habit consistency (check-ins answered, breaks taken, streaks held) and explicitly does **not** read Mood or Tilt. It is private by default, and leaderboards rank only opt-in, non-sensitive metrics (XP, streak length). Mood, Tilt, and the raw Wellness Score never appear on a leaderboard.

## Why

Wabi handles sensitive mental-health-adjacent signals (ADR-0001). Surfacing them socially — even indirectly via a "wellness" ranking — would turn a person's bad week into a public comparison and erode the trust the product depends on. Separating "how you feel" from "what you do" lets gamification stay motivating without ever leaking inner state.
