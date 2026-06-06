-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "email" TEXT,
    "stripeCustomerId" TEXT,
    "hasActiveAccess" BOOLEAN NOT NULL DEFAULT false,
    "trialEndsAt" TIMESTAMP(3),
    "subscriptionStatus" TEXT NOT NULL DEFAULT 'trialing',
    "consentAcceptedAt" TIMESTAMP(3),
    "locale" TEXT NOT NULL DEFAULT 'en-US',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "checkInsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "checkInCadence" TEXT NOT NULL DEFAULT 'daily',
    "quietHoursStart" INTEGER NOT NULL DEFAULT 22,
    "quietHoursEnd" INTEGER NOT NULL DEFAULT 8,
    "lastCheckIn" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastActivity" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mined" BOOLEAN NOT NULL DEFAULT false,
    "doNotMine" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoachingSession" (
    "id" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastActivity" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mined" BOOLEAN NOT NULL DEFAULT false,
    "doNotMine" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoachingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiConversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mood" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "emoji" TEXT NOT NULL,
    "note" TEXT,
    "context" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mood_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaytimeLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "duration" INTEGER NOT NULL,
    "game" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlaytimeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "reflection" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XpEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XpEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TiltSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "severity" INTEGER NOT NULL,
    "technique" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TiltSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EscalationEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "layer" TEXT NOT NULL DEFAULT 'tripwire',

    CONSTRAINT "EscalationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedStripeEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessedStripeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyDraft" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "technique" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "sourceText" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "trustLevel" TEXT NOT NULL DEFAULT 'community',
    "status" TEXT NOT NULL DEFAULT 'pending-review',
    "negativeCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StrategyDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_discordId_key" ON "User"("discordId");

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "User_discordId_idx" ON "User"("discordId");

-- CreateIndex
CREATE INDEX "User_hasActiveAccess_idx" ON "User"("hasActiveAccess");

-- CreateIndex
CREATE INDEX "User_stripeCustomerId_idx" ON "User"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_lastActivity_idx" ON "Session"("lastActivity");

-- CreateIndex
CREATE UNIQUE INDEX "CoachingSession_discordId_key" ON "CoachingSession"("discordId");

-- CreateIndex
CREATE INDEX "CoachingSession_discordId_idx" ON "CoachingSession"("discordId");

-- CreateIndex
CREATE INDEX "CoachingSession_lastActivity_idx" ON "CoachingSession"("lastActivity");

-- CreateIndex
CREATE INDEX "CoachingSession_mined_idx" ON "CoachingSession"("mined");

-- CreateIndex
CREATE INDEX "AiConversation_userId_idx" ON "AiConversation"("userId");

-- CreateIndex
CREATE INDEX "Mood_userId_idx" ON "Mood"("userId");

-- CreateIndex
CREATE INDEX "Mood_createdAt_idx" ON "Mood"("createdAt");

-- CreateIndex
CREATE INDEX "PlaytimeLog_userId_idx" ON "PlaytimeLog"("userId");

-- CreateIndex
CREATE INDEX "PlaytimeLog_createdAt_idx" ON "PlaytimeLog"("createdAt");

-- CreateIndex
CREATE INDEX "JournalEntry_userId_idx" ON "JournalEntry"("userId");

-- CreateIndex
CREATE INDEX "JournalEntry_createdAt_idx" ON "JournalEntry"("createdAt");

-- CreateIndex
CREATE INDEX "XpEntry_userId_idx" ON "XpEntry"("userId");

-- CreateIndex
CREATE INDEX "XpEntry_createdAt_idx" ON "XpEntry"("createdAt");

-- CreateIndex
CREATE INDEX "TiltSession_userId_idx" ON "TiltSession"("userId");

-- CreateIndex
CREATE INDEX "TiltSession_resolved_idx" ON "TiltSession"("resolved");

-- CreateIndex
CREATE INDEX "TiltSession_createdAt_idx" ON "TiltSession"("createdAt");

-- CreateIndex
CREATE INDEX "EscalationEvent_userId_idx" ON "EscalationEvent"("userId");

-- CreateIndex
CREATE INDEX "EscalationEvent_timestamp_idx" ON "EscalationEvent"("timestamp");

-- CreateIndex
CREATE INDEX "ProcessedStripeEvent_type_idx" ON "ProcessedStripeEvent"("type");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedStripeEvent_id_key" ON "ProcessedStripeEvent"("id");

-- CreateIndex
CREATE INDEX "StrategyDraft_status_idx" ON "StrategyDraft"("status");

-- CreateIndex
CREATE INDEX "StrategyDraft_trustLevel_idx" ON "StrategyDraft"("trustLevel");

-- CreateIndex
CREATE INDEX "StrategyDraft_negativeCount_idx" ON "StrategyDraft"("negativeCount");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

