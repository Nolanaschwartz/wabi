-- One Engagement per (userId, engaged-day), enforced at the database (ADR-0027).
--
-- The "once per day" rule must not depend on the racy app-level isNewDay check: two events
-- (journal + coaching) arriving in the same instant both observe "new day" and both try to log
-- today's Engagement. The (userId, engagedDay) unique index is the backstop -- the second insert is
-- rejected (P2002), which HabitEngagementService.record treats as a benign "already engaged".
--
-- engagedDay is the person-tz calendar day ("YYYY-MM-DD") computed by the writer at insert time, so
-- the constraint buckets on the SAME boundary as the streak/profile reads (no UTC asymmetry). It is a
-- plain column, so db:push and the integration harness create the index too -- not just this migration.

ALTER TABLE "XpEntry" ADD COLUMN "engagedDay" TEXT;

-- Backfill existing rows: best-effort UTC calendar day of createdAt (Prisma stores UTC). Historical
-- rows predate per-tz keying; going forward the app supplies the person-tz key.
UPDATE "XpEntry" SET "engagedDay" = to_char("createdAt", 'YYYY-MM-DD') WHERE "engagedDay" IS NULL;

-- Dedupe pre-existing same-(userId, engagedDay) rows BEFORE the unique index, so the migration never
-- aborts on historical duplicates (prior races/double-writes). Keep the earliest row per engaged day.
DELETE FROM "XpEntry" a
  USING "XpEntry" b
  WHERE a."userId" = b."userId"
    AND a."engagedDay" = b."engagedDay"
    AND (a."createdAt" > b."createdAt"
         OR (a."createdAt" = b."createdAt" AND a."id" > b."id"));

ALTER TABLE "XpEntry" ALTER COLUMN "engagedDay" SET NOT NULL;

CREATE UNIQUE INDEX "XpEntry_userId_engagedDay_key" ON "XpEntry" ("userId", "engagedDay");
