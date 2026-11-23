-- CreateTable
CREATE TABLE "kg_ledger" (
    "run_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "mode" VARCHAR(8) NOT NULL,
    "procedure_version_id" VARCHAR(200),
    "run_status" VARCHAR(16) NOT NULL,
    "steps_replayed" INTEGER NOT NULL DEFAULT 0,
    "steps_recovered" INTEGER NOT NULL DEFAULT 0,
    "steps_judge" INTEGER NOT NULL DEFAULT 0,
    "steps_agent" INTEGER NOT NULL DEFAULT 0,
    "model_calls" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cached_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "cost_known" BOOLEAN NOT NULL DEFAULT true,
    "active_ms" INTEGER NOT NULL DEFAULT 0,
    "outcome" VARCHAR(16) NOT NULL,
    "checks_passed" BOOLEAN,
    "finished_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kg_ledger_pkey" PRIMARY KEY ("run_id")
);

-- CreateIndex
CREATE INDEX "kg_ledger_user_id_task_id_finished_at_idx" ON "kg_ledger"("user_id", "task_id", "finished_at");

-- AddForeignKey
ALTER TABLE "kg_ledger" ADD CONSTRAINT "kg_ledger_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_ledger" ADD CONSTRAINT "kg_ledger_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_ledger" ADD CONSTRAINT "kg_ledger_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
