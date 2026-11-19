-- Identity details the agent fills without seeing them (E37.6, #595): the opt-ins and what a run records. No secret is stored here.
-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "use_saved_identity" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN "use_saved_identity" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "connected_app_settings" ADD COLUMN "allow_saved_identity" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "runs" ADD COLUMN "used_saved_identity" JSONB;
