-- One Engagement per (userId, engaged-day), enforced at the database (ADR-0027).
--
-- The "once per day" rule must not depend on the racy app-level isNewDay check: two events
-- (e.g. journal + coaching) arriving in the same instant both observe "new day" and both try to
-- log today's Engagement. This unique index is the backstop -- the second insert is rejected, and
-- HabitEngagementService.record treats the Prisma P2002 violation as a benign "already engaged".
--
-- Prisma's @@unique cannot express a date_trunc, so this is a hand-authored expression unique index.
--
-- CANONICAL ZONE = UTC (accepted asymmetry). "createdAt" is timestamp(3) WITHOUT TIME ZONE and
-- Prisma always stores UTC wall-clock values, so date_trunc('day', "createdAt") yields the UTC day
-- and is IMMUTABLE (required for an index expression). The per-user-timezone day-boundary logic
-- stays in the read/streak path; this constraint is only a coarse backstop against simultaneous
-- inserts, not per-user-tz day correctness (see PRD: per-user-tz enforcement in the DB is out of
-- scope by design).
CREATE UNIQUE INDEX "XpEntry_userId_utc_day_key"
  ON "XpEntry" ("userId", (date_trunc('day', "createdAt")));
