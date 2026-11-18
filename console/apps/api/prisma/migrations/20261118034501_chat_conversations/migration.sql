-- CreateEnum
CREATE TYPE "conversation_status" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "chat_message_role" AS ENUM ('user', 'assistant', 'system');

-- CreateEnum
CREATE TYPE "chat_message_kind" AS ENUM ('text', 'clarify', 'run', 'result', 'task_draft');

-- AlterEnum
ALTER TYPE "run_trigger" ADD VALUE 'chat';

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "conversation_id" UUID;

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL DEFAULT '',
    "status" "conversation_status" NOT NULL DEFAULT 'active',
    "profile" VARCHAR(32) NOT NULL DEFAULT 'default',
    "host_id" UUID,
    "host_fallback" BOOLEAN NOT NULL DEFAULT true,
    "policy_ref" VARCHAR(64),
    "next_seq" INTEGER NOT NULL DEFAULT 1,
    "last_message_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" "chat_message_role" NOT NULL,
    "kind" "chat_message_kind" NOT NULL DEFAULT 'text',
    "text" VARCHAR(8000) NOT NULL DEFAULT '',
    "run_id" UUID,
    "meta" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversations_user_id_status_last_message_at_idx" ON "conversations"("user_id", "status", "last_message_at");

-- CreateIndex
CREATE INDEX "chat_messages_run_id_idx" ON "chat_messages"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_messages_conversation_id_seq_key" ON "chat_messages"("conversation_id", "seq");

-- CreateIndex
CREATE INDEX "runs_conversation_id_created_at_idx" ON "runs"("conversation_id", "created_at");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
