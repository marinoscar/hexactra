-- AlterEnum
ALTER TYPE "chat_message_kind" ADD VALUE 'batch';

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "batch_id" UUID,
ADD COLUMN     "batch_seq" INTEGER;

-- CreateTable
CREATE TABLE "run_batches" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "conversation_id" UUID,
    "trigger" "run_trigger" NOT NULL DEFAULT 'manual',
    "origin" "run_origin" NOT NULL DEFAULT 'web',
    "policy_ref" VARCHAR(64),
    "client_id" UUID,
    "client_name" VARCHAR(64),
    "grant_id" UUID,
    "app_limits" JSONB,
    "status" VARCHAR(12) NOT NULL DEFAULT 'running',
    "total" INTEGER NOT NULL,
    "on_failure" VARCHAR(12) NOT NULL DEFAULT 'continue',
    "stop_reason" VARCHAR(40),
    "stopped_at_seq" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "run_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_batch_items" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "inputs" JSONB NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'pending',
    "run_id" UUID,
    "started_at" TIMESTAMPTZ,

    CONSTRAINT "run_batch_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "run_batches_user_id_created_at_idx" ON "run_batches"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "run_batches_task_id_created_at_idx" ON "run_batches"("task_id", "created_at");

-- CreateIndex
CREATE INDEX "run_batches_conversation_id_created_at_idx" ON "run_batches"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "run_batches_status_idx" ON "run_batches"("status");

-- CreateIndex
CREATE UNIQUE INDEX "run_batch_items_run_id_key" ON "run_batch_items"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "run_batch_items_batch_id_seq_key" ON "run_batch_items"("batch_id", "seq");

-- CreateIndex
CREATE INDEX "runs_batch_id_batch_seq_idx" ON "runs"("batch_id", "batch_seq");

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "run_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_batches" ADD CONSTRAINT "run_batches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_batches" ADD CONSTRAINT "run_batches_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_batches" ADD CONSTRAINT "run_batches_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_batch_items" ADD CONSTRAINT "run_batch_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "run_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_batch_items" ADD CONSTRAINT "run_batch_items_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
