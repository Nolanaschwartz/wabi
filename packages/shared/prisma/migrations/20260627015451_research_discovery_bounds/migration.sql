-- AlterTable
ALTER TABLE "ResearchConfig" ADD COLUMN     "budgetPressureFraction" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
ADD COLUMN     "maxChasePerExpansion" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "maxNeighborsConsidered" INTEGER NOT NULL DEFAULT 15;
