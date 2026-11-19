-- Pause and Resume (E38.2, #583): a run the owner can freeze and continue later. A paused run is live: it holds its browser
-- session and its memory, and its time budget does not run.
-- AlterEnum
ALTER TYPE "run_status" ADD VALUE 'paused';

-- AlterTable
ALTER TABLE "runs" ADD COLUMN "pause_requested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "paused_at" TIMESTAMPTZ,
ADD COLUMN "pause_notified_at" TIMESTAMPTZ;
