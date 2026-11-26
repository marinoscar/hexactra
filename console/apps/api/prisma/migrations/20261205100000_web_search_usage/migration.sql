-- CreateTable
CREATE TABLE "web_search_usage" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "estimated_cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "web_search_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "web_search_usage_day_idx" ON "web_search_usage"("day");

-- CreateIndex
CREATE UNIQUE INDEX "web_search_usage_user_id_day_provider_key" ON "web_search_usage"("user_id", "day", "provider");

-- AddForeignKey
ALTER TABLE "web_search_usage" ADD CONSTRAINT "web_search_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
