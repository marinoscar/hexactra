-- CreateEnum
CREATE TYPE "run_status" AS ENUM ('queued', 'running', 'waiting_human', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "run_trigger" AS ENUM ('manual', 'schedule', 'api', 'mcp', 'external');

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "goal" VARCHAR(4000) NOT NULL,
    "profile" VARCHAR(32) NOT NULL DEFAULT 'default',
    "host_id" UUID,
    "allowed_domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "max_steps" INTEGER NOT NULL DEFAULT 40,
    "max_minutes" INTEGER NOT NULL DEFAULT 15,
    "confirm_risky_actions" BOOLEAN NOT NULL DEFAULT true,
    "model" VARCHAR(200),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "task_id" UUID,
    "status" "run_status" NOT NULL DEFAULT 'queued',
    "trigger" "run_trigger" NOT NULL DEFAULT 'manual',
    "goal" VARCHAR(4000) NOT NULL,
    "profile" VARCHAR(32) NOT NULL DEFAULT 'default',
    "host_id" UUID,
    "session_id" UUID,
    "handoff_id" UUID,
    "actor" VARCHAR(200),
    "result" VARCHAR(8000),
    "error" VARCHAR(2000),
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "step_count" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "transcript" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_steps" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "action" VARCHAR(40),
    "args" JSONB,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "summary" VARCHAR(2000) NOT NULL DEFAULT '',
    "reasoning" VARCHAR(2000),
    "screenshot_key" VARCHAR(500),
    "duration_ms" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tasks_user_id_created_at_idx" ON "tasks"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "runs_user_id_created_at_idx" ON "runs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "runs_task_id_created_at_idx" ON "runs"("task_id", "created_at");

-- CreateIndex
CREATE INDEX "runs_status_idx" ON "runs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "run_steps_run_id_seq_key" ON "run_steps"("run_id", "seq");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
