-- DropIndex
DROP INDEX "User_hasActiveAccess_idx";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "hasActiveAccess";
