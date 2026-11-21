-- AI usage rollups (#732, epic #730): ai_usage_events summed per UTC hour, and
-- the one-row watermark of how far they go. Written only by the usage.rollup job.

-- CreateTable
CREATE TABLE "ai_usage_hourly" (
    "id" UUID NOT NULL,
    "hour" TIMESTAMPTZ NOT NULL,
    "org_id" UUID,
    "user_id" UUID,
    "provider" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "feature" TEXT,
    "key_source" TEXT NOT NULL,
    "requests" INTEGER NOT NULL,
    "failed" INTEGER NOT NULL,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "cached_input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "reasoning_tokens" BIGINT NOT NULL DEFAULT 0,
    "untokened_requests" INTEGER NOT NULL DEFAULT 0,
    "latency_ms_sum" BIGINT NOT NULL DEFAULT 0,
    "units" JSONB,

    CONSTRAINT "ai_usage_hourly_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_rollup_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "rolled_until" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_rollup_state_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_usage_rollup_state_one_row" CHECK ("id" = 1)
);

-- CreateIndex
CREATE INDEX "ai_usage_hourly_hour_idx" ON "ai_usage_hourly"("hour");

-- CreateIndex
CREATE INDEX "ai_usage_hourly_user_id_hour_idx" ON "ai_usage_hourly"("user_id", "hour");

-- CreateIndex
CREATE INDEX "ai_usage_hourly_org_id_hour_idx" ON "ai_usage_hourly"("org_id", "hour");

-- AddForeignKey
ALTER TABLE "ai_usage_hourly" ADD CONSTRAINT "ai_usage_hourly_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
