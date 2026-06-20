-- DropIndex
DROP INDEX "Mood_userId_idx";

-- DropIndex
DROP INDEX "PlaytimeLog_userId_idx";

-- DropIndex
DROP INDEX "JournalEntry_userId_idx";

-- DropIndex
DROP INDEX "XpEntry_userId_idx";

-- CreateIndex
CREATE INDEX "Mood_userId_createdAt_idx" ON "Mood"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "PlaytimeLog_userId_createdAt_idx" ON "PlaytimeLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "JournalEntry_userId_createdAt_idx" ON "JournalEntry"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "XpEntry_userId_createdAt_idx" ON "XpEntry"("userId", "createdAt");

