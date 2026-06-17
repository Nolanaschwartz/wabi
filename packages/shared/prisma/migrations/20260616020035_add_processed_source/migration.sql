-- CreateTable
CREATE TABLE "ProcessedSource" (
    "sourceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "lastStatus" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessedSource_pkey" PRIMARY KEY ("sourceId")
);
