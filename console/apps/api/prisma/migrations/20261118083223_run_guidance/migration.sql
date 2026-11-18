-- CreateTable
CREATE TABLE "run_guidance" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "message_seq" INTEGER NOT NULL,
    "note" VARCHAR(1000) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ,

    CONSTRAINT "run_guidance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "run_guidance_run_id_delivered_at_idx" ON "run_guidance"("run_id", "delivered_at");

-- CreateIndex
CREATE INDEX "run_guidance_conversation_id_idx" ON "run_guidance"("conversation_id");

-- AddForeignKey
ALTER TABLE "run_guidance" ADD CONSTRAINT "run_guidance_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_guidance" ADD CONSTRAINT "run_guidance_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
