-- CreateTable
CREATE TABLE "ResearchConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "scheduleCron" TEXT,
    "scheduleEnabled" BOOLEAN NOT NULL DEFAULT false,
    "maxTopicsPerRun" INTEGER NOT NULL DEFAULT 5,
    "maxPapersPerTopic" INTEGER NOT NULL DEFAULT 8,
    "maxDiscoverySteps" INTEGER NOT NULL DEFAULT 2,
    "maxDraftsPerTopic" INTEGER NOT NULL DEFAULT 3,
    "maxDraftsPerRun" INTEGER NOT NULL DEFAULT 10,
    "agentTimeoutMs" INTEGER NOT NULL DEFAULT 90000,
    "runTimeoutMs" INTEGER NOT NULL DEFAULT 600000,
    "tokenBudget" INTEGER NOT NULL DEFAULT 200000,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchTopic" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchTopic_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ResearchTopic_text_key" ON "ResearchTopic"("text");
