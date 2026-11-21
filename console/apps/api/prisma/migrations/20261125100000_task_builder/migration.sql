-- CreateEnum
CREATE TYPE "conversation_mode" AS ENUM ('chat', 'task_builder');

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "builder_spec" JSONB,
ADD COLUMN     "mode" "conversation_mode" NOT NULL DEFAULT 'chat';

-- CreateIndex
CREATE INDEX "conversations_user_id_mode_status_last_message_at_idx" ON "conversations"("user_id", "mode", "status", "last_message_at");
