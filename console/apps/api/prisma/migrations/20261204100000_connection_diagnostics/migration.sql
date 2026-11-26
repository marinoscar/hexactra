-- E50.10 (#980): the history of diagnostics, the last 20 reports per target (connection, provider app, search provider). Codes, counts
-- and timings only. A new table: the connections table gets no column ("last checked" is read from here).

-- CreateTable
CREATE TABLE "connection_diagnostics" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "target_kind" VARCHAR(20) NOT NULL,
    "target_id" VARCHAR(80) NOT NULL,
    "overall" VARCHAR(10) NOT NULL,
    "stages" JSONB NOT NULL,
    "trigger" VARCHAR(20) NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connection_diagnostics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "connection_diagnostics_target_kind_target_id_created_at_idx" ON "connection_diagnostics"("target_kind", "target_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "connection_diagnostics_user_id_target_kind_idx" ON "connection_diagnostics"("user_id", "target_kind");

-- AddForeignKey
ALTER TABLE "connection_diagnostics" ADD CONSTRAINT "connection_diagnostics_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
