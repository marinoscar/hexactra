-- AlterEnum
ALTER TYPE "run_trigger" ADD VALUE 'email';

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "context" JSONB,
ADD COLUMN     "mail_trigger_id" UUID;

-- CreateTable
CREATE TABLE "mail_triggers" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "match" JSONB NOT NULL,
    "inputs" JSONB,
    "after_start" VARCHAR(80) NOT NULL DEFAULT 'none',
    "cursor" VARCHAR(500),
    "active_since" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "poll_seconds" INTEGER NOT NULL DEFAULT 300,
    "max_runs_per_day" INTEGER NOT NULL DEFAULT 10,
    "next_poll_at" TIMESTAMPTZ,
    "last_checked_at" TIMESTAMPTZ,
    "last_matched_at" TIMESTAMPTZ,
    "status" VARCHAR(30) NOT NULL DEFAULT 'ok',
    "status_reason" VARCHAR(60),
    "consecutive_errors" INTEGER NOT NULL DEFAULT 0,
    "status_notified_at" TIMESTAMPTZ,
    "unverified_notified_on" VARCHAR(10),
    "limit_notified_on" VARCHAR(10),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "mail_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_trigger_events" (
    "id" UUID NOT NULL,
    "trigger_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "message_id" VARCHAR(255) NOT NULL,
    "run_id" UUID,
    "outcome" VARCHAR(30) NOT NULL,
    "reason" VARCHAR(60),
    "message_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_trigger_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mail_triggers_user_id_idx" ON "mail_triggers"("user_id");

-- CreateIndex
CREATE INDEX "mail_triggers_task_id_idx" ON "mail_triggers"("task_id");

-- CreateIndex
CREATE INDEX "mail_triggers_connection_id_idx" ON "mail_triggers"("connection_id");

-- CreateIndex
CREATE INDEX "mail_triggers_enabled_next_poll_at_idx" ON "mail_triggers"("enabled", "next_poll_at");

-- CreateIndex
CREATE INDEX "mail_trigger_events_user_id_created_at_idx" ON "mail_trigger_events"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "mail_trigger_events_trigger_id_created_at_idx" ON "mail_trigger_events"("trigger_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "mail_trigger_events_trigger_id_message_id_key" ON "mail_trigger_events"("trigger_id", "message_id");

-- AddForeignKey
ALTER TABLE "mail_triggers" ADD CONSTRAINT "mail_triggers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_triggers" ADD CONSTRAINT "mail_triggers_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_trigger_events" ADD CONSTRAINT "mail_trigger_events_trigger_id_fkey" FOREIGN KEY ("trigger_id") REFERENCES "mail_triggers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_trigger_events" ADD CONSTRAINT "mail_trigger_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
