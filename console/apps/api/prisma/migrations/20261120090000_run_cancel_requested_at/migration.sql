-- When the owner pressed Stop on a run (E38.1, #582): the start of the stop-latency measure (request to terminal status).
-- AlterTable
ALTER TABLE "runs" ADD COLUMN "cancel_requested_at" TIMESTAMP(3);
