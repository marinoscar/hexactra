-- CreateEnum
CREATE TYPE "run_origin" AS ENUM ('web', 'android', 'cli', 'api', 'mcp', 'schedule', 'system');

-- AlterTable
ALTER TABLE "questions" ADD COLUMN     "client_id" UUID,
ADD COLUMN     "client_name" VARCHAR(64),
ADD COLUMN     "grant_id" UUID;

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "app_limits" JSONB,
ADD COLUMN     "client_id" UUID,
ADD COLUMN     "client_name" VARCHAR(64),
ADD COLUMN     "grant_id" UUID,
ADD COLUMN     "origin" "run_origin" NOT NULL DEFAULT 'web';

-- CreateTable
CREATE TABLE "connected_app_settings" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "policy_id" VARCHAR(64),
    "allowed_policy_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowed_domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "max_concurrent_runs" INTEGER NOT NULL DEFAULT 2,
    "daily_run_limit" INTEGER NOT NULL DEFAULT 50,
    "daily_cost_limit_usd" DECIMAL(10,2),
    "confirm_purchases" BOOLEAN NOT NULL DEFAULT true,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "notified_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "first_run_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "connected_app_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "connected_app_settings_user_id_client_id_key" ON "connected_app_settings"("user_id", "client_id");

-- CreateIndex
CREATE INDEX "runs_user_id_client_id_created_at_idx" ON "runs"("user_id", "client_id", "created_at");

-- AddForeignKey
ALTER TABLE "connected_app_settings" ADD CONSTRAINT "connected_app_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill (#464): where existing runs came from, as far as `trigger` tells.
-- A manual run and a chat run were started in the console; an external
-- session and an ad-hoc API run by an API caller (the SDK, a script or an
-- agent framework); runs recorded as `mcp` by an MCP client.
UPDATE "runs" SET "origin" = CASE "trigger"
    WHEN 'schedule' THEN 'schedule'::"run_origin"
    WHEN 'api' THEN 'api'::"run_origin"
    WHEN 'external' THEN 'api'::"run_origin"
    WHEN 'mcp' THEN 'mcp'::"run_origin"
    ELSE 'web'::"run_origin"
  END;
