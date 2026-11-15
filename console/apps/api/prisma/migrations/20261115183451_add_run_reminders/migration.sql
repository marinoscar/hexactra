-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "handoff_expires_at" TIMESTAMPTZ,
ADD COLUMN     "remind_at" TIMESTAMPTZ,
ADD COLUMN     "reminded_at" TIMESTAMPTZ,
ADD COLUMN     "reminder_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "snoozed_until" TIMESTAMPTZ,
ADD COLUMN     "waiting_since" TIMESTAMPTZ;

-- CreateIndex
CREATE INDEX "runs_remind_at_idx" ON "runs"("remind_at");
