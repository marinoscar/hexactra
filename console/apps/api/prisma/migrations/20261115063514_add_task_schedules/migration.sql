-- CreateEnum
CREATE TYPE "schedule_concurrency" AS ENUM ('skip', 'queue');

-- CreateTable
CREATE TABLE "task_schedules" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "cron" VARCHAR(100) NOT NULL,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "concurrency" "schedule_concurrency" NOT NULL DEFAULT 'skip',
    "next_run_at" TIMESTAMPTZ,
    "last_run_at" TIMESTAMPTZ,
    "last_run_id" UUID,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "task_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_schedules_enabled_next_run_at_idx" ON "task_schedules"("enabled", "next_run_at");

-- CreateIndex
CREATE INDEX "task_schedules_user_id_idx" ON "task_schedules"("user_id");

-- AddForeignKey
ALTER TABLE "task_schedules" ADD CONSTRAINT "task_schedules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_schedules" ADD CONSTRAINT "task_schedules_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
