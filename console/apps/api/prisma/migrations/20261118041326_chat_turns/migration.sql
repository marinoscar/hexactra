-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "allowed_domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "answered_seq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "confirm_risky_actions" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "turn_lease_until" TIMESTAMPTZ;
