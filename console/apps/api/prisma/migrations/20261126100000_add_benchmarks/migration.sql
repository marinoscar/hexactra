-- AlterEnum
ALTER TYPE "run_trigger" ADD VALUE 'benchmark';

-- CreateTable
CREATE TABLE "benchmarks" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "suite_key" VARCHAR(32) NOT NULL,
    "suite_version" INTEGER NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'queued',
    "config" JSONB NOT NULL,
    "app_version" VARCHAR(32) NOT NULL,
    "commit" VARCHAR(64),
    "spent_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "summary" JSONB,
    "baseline_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "benchmarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benchmark_trials" (
    "id" UUID NOT NULL,
    "benchmark_id" UUID NOT NULL,
    "challenge_id" VARCHAR(64) NOT NULL,
    "policy_ref" VARCHAR(64) NOT NULL,
    "policy_label" VARCHAR(200) NOT NULL,
    "trial_index" INTEGER NOT NULL,
    "seed" VARCHAR(64) NOT NULL,
    "token_hash" VARCHAR(64),
    "run_id" UUID,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "verdict" VARCHAR(16),
    "failure_reason" VARCHAR(32),
    "checks" JSONB,
    "claimed_success" BOOLEAN,
    "site_state" JSONB,
    "site_state_version" INTEGER NOT NULL DEFAULT 0,
    "duration_ms" INTEGER,
    "active_ms" INTEGER,
    "steps" INTEGER,
    "model_calls" INTEGER,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cost_usd" DECIMAL(12,6),
    "cost_known" BOOLEAN,
    "stop_reason" VARCHAR(32),
    "questions" INTEGER,
    "escalations" INTEGER,
    "policy_snapshot" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "benchmark_trials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "benchmarks_user_id_created_at_idx" ON "benchmarks"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "benchmarks_status_idx" ON "benchmarks"("status");

-- CreateIndex
CREATE INDEX "benchmarks_baseline_id_idx" ON "benchmarks"("baseline_id");

-- CreateIndex
CREATE UNIQUE INDEX "benchmark_trials_token_hash_key" ON "benchmark_trials"("token_hash");

-- CreateIndex
CREATE INDEX "benchmark_trials_run_id_idx" ON "benchmark_trials"("run_id");

-- CreateIndex
CREATE INDEX "benchmark_trials_benchmark_id_status_idx" ON "benchmark_trials"("benchmark_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "benchmark_trials_benchmark_id_challenge_id_policy_ref_trial_key" ON "benchmark_trials"("benchmark_id", "challenge_id", "policy_ref", "trial_index");

-- AddForeignKey
ALTER TABLE "benchmarks" ADD CONSTRAINT "benchmarks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benchmarks" ADD CONSTRAINT "benchmarks_baseline_id_fkey" FOREIGN KEY ("baseline_id") REFERENCES "benchmarks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benchmark_trials" ADD CONSTRAINT "benchmark_trials_benchmark_id_fkey" FOREIGN KEY ("benchmark_id") REFERENCES "benchmarks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benchmark_trials" ADD CONSTRAINT "benchmark_trials_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
