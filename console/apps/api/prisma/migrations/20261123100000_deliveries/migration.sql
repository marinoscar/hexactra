-- Deliveries after a run (E39.6, #603): what the owner configured on a task (task_deliveries), what happened for each run (run_deliveries,
-- one row per run and delivery: the idempotency anchor), the recipients the owner confirmed (delivery_recipients), and the deliveries a
-- schedule uses (task_schedules.delivery_ids). No secret and no content is stored here.
-- AlterTable
ALTER TABLE "task_schedules" ADD COLUMN     "delivery_ids" JSONB;
-- CreateTable
CREATE TABLE "task_deliveries" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "send_when" VARCHAR(20) NOT NULL DEFAULT 'always',
    "config" JSONB NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "connection_id" UUID,
    "disabled_reason" VARCHAR(40),
    "failure_notified_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "task_deliveries_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "run_deliveries" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "delivery_id" UUID,
    "kind" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "detail" JSONB,
    "error_code" VARCHAR(60),
    "sent_at" TIMESTAMPTZ,
    "next_attempt_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "run_deliveries_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "delivery_recipients" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "address" VARCHAR(320) NOT NULL,
    "confirmed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notice_sent_at" TIMESTAMPTZ,
    "unsubscribed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "delivery_recipients_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "task_deliveries_task_id_position_idx" ON "task_deliveries"("task_id", "position");
-- CreateIndex
CREATE INDEX "task_deliveries_user_id_connection_id_idx" ON "task_deliveries"("user_id", "connection_id");
-- CreateIndex
CREATE INDEX "run_deliveries_run_id_idx" ON "run_deliveries"("run_id");
-- CreateIndex
CREATE INDEX "run_deliveries_user_id_kind_created_at_idx" ON "run_deliveries"("user_id", "kind", "created_at");
-- CreateIndex
CREATE UNIQUE INDEX "run_deliveries_run_id_delivery_id_key" ON "run_deliveries"("run_id", "delivery_id");
-- CreateIndex
CREATE UNIQUE INDEX "delivery_recipients_user_id_address_key" ON "delivery_recipients"("user_id", "address");
-- AddForeignKey
ALTER TABLE "task_deliveries" ADD CONSTRAINT "task_deliveries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "task_deliveries" ADD CONSTRAINT "task_deliveries_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "run_deliveries" ADD CONSTRAINT "run_deliveries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "run_deliveries" ADD CONSTRAINT "run_deliveries_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "run_deliveries" ADD CONSTRAINT "run_deliveries_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "task_deliveries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "delivery_recipients" ADD CONSTRAINT "delivery_recipients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
