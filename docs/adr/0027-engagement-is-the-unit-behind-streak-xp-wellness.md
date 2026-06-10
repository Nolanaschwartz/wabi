# Engagement is the single logged unit behind Streak, XP, and Wellness Score

A person's gentle gamification — **Streak**, **XP**, **Wellness Score** — derives from one stored unit: an **Engagement**, a record that the person completed a self-care habit (a coaching turn, a Journal Entry, an answered Check-in). One writer records exactly one Engagement per habit-event; the three progress measures are computed from the Engagement log, never hand-wired at each surface.

- **Streak** = consecutive days with ≥1 Engagement.
- **XP** = the sum of points carried by each Engagement.
- **Wellness Score** = Engagement density over a 30-day window — each habit-event counted once.

This replaces the prior arrangement, where the `xpEntry` ledger did double duty (a points tally *and* the "engaged today" signal a Streak was derived from), rewards were hand-wired per surface, and the Wellness Score summed `xpEntry` rows **plus** `journalEntry` rows.

## Why

Conflating points with the engagement signal produced two latent defects this decision removes:

- **Journal entries double-counted in Wellness.** A journal write created an `xpEntry` *and* a `journalEntry`; the Wellness formula counted both, so one habit-event scored as two.
- **Streak logic only fired on coaching.** Journaling silently advanced the streak *count* (any `xpEntry` that day) but never ran the grace-day / "welcome back" logic, which lived only in the coaching path. The number and the behaviour disagreed.

Making Engagement the single unit gives one writer, one place the gentle-gamification invariants live (ADR-0007: never shame; XP only accrues), and one structural guarantee that the **Wellness Score reads only Engagement, never Mood or Tilt** (ADR-0002) — because the read model depends on the Engagement log and nothing else.

This is a deliberate **behaviour change**: existing Wellness scores shift (journals stop double-counting) and streak semantics become uniform across habits. Recorded here so a future review does not "restore" the old numbers as a regression.

## The habit → Engagement table

Which habits emit an Engagement, and for how much XP, is a gentle-gamification tuning decision (ADR-0007) made by editing one table. The initial set mirrors today's XP-awarding actions, so the migration is behaviour-preserving apart from the two bug fixes above:

| Habit | Emits Engagement | XP | Advances Streak |
|---|---|---|---|
| Coaching turn | yes | 10 | yes |
| Journal Entry | yes | 10 | yes |
| Mood log / Tilt Session / Playtime log | not yet | — | — |

Expanding the set (e.g. a Mood log counting as engagement) is a one-line table change and a product call — not a code-structure change.

## Consequences

- The `xpEntry` table becomes the Engagement log; rows carry the habit and its points. Streak, XP total, and Wellness Score are read models over it.
- Adding a new self-care habit means emitting one Engagement through the single writer — no surface re-encodes XP amounts or streak rules.
- A future architecture review should not re-suggest "consolidate the XP calls"; that is this ADR.
