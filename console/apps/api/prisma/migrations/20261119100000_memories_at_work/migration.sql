-- AlterEnum
ALTER TYPE "chat_message_kind" ADD VALUE 'memory';

-- AlterEnum
ALTER TYPE "question_input" ADD VALUE 'memory';

-- AlterTable
ALTER TABLE "questions" ADD COLUMN     "blocking" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "conversation_id" UUID,
ADD COLUMN     "proposal" JSONB,
ADD COLUMN     "proposal_key" VARCHAR(64);

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "memory_ids" UUID[] DEFAULT ARRAY[]::UUID[];

-- CreateIndex
CREATE INDEX "questions_owner_user_id_proposal_key_idx" ON "questions"("owner_user_id", "proposal_key");
