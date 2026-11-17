-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "current_tier" VARCHAR(16),
ADD COLUMN     "escalations" INTEGER NOT NULL DEFAULT 0;
