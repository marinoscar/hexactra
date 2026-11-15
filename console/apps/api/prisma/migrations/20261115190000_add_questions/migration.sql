-- CreateEnum
CREATE TYPE "question_input" AS ENUM ('none', 'text', 'secret', 'choice', 'multi_choice', 'number', 'confirm', 'takeover');

-- CreateEnum
CREATE TYPE "question_status" AS ENUM ('pending', 'answered', 'cancelled', 'expired');

-- CreateTable
CREATE TABLE "questions" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "asked_by" VARCHAR(200) NOT NULL,
    "run_id" UUID,
    "fabric_session_id" UUID,
    "handoff_id" UUID,
    "input" "question_input" NOT NULL DEFAULT 'none',
    "kind" VARCHAR(20) NOT NULL DEFAULT 'other',
    "prompt" VARCHAR(2000) NOT NULL,
    "options" JSONB,
    "constraints" JSONB,
    "confirm_label" VARCHAR(40),
    "deny_label" VARCHAR(40),
    "risk" VARCHAR(8),
    "page_title" VARCHAR(500),
    "viewer_url" VARCHAR(2000),
    "status" "question_status" NOT NULL DEFAULT 'pending',
    "response" JSONB,
    "answered_by_user_id" UUID,
    "answered_channel" VARCHAR(40),
    "answered_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "questions_handoff_id_key" ON "questions"("handoff_id");

-- CreateIndex
CREATE INDEX "questions_owner_user_id_status_created_at_idx" ON "questions"("owner_user_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "questions_status_expires_at_idx" ON "questions"("status", "expires_at");

-- CreateIndex
CREATE INDEX "questions_run_id_idx" ON "questions"("run_id");

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
