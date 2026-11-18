-- Saved approvals (#554): the owner's standing rules and their recent uses. A rule is created only by the owner's tick on a server-issued question.
-- CreateEnum
CREATE TYPE "approval_rule_kind" AS ENUM ('gate', 'ask');

-- CreateTable
CREATE TABLE "approval_rules" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "approval_rule_kind" NOT NULL,
    "host" VARCHAR(253) NOT NULL,
    "category" VARCHAR(20) NOT NULL DEFAULT '',
    "match_key" VARCHAR(200) NOT NULL,
    "summary" VARCHAR(300) NOT NULL,
    "task_id" VARCHAR(36) NOT NULL DEFAULT '',
    "conversation_id" VARCHAR(36) NOT NULL DEFAULT '',
    "max_amount" DECIMAL(12,2),
    "expires_at" TIMESTAMPTZ,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_from_question_id" UUID,
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" TIMESTAMPTZ,
    "last_used_run_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "approval_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_rule_uses" (
    "id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "run_id" UUID,
    "step_seq" INTEGER,
    "used_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_rule_uses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "approval_rules_user_id_host_enabled_idx" ON "approval_rules"("user_id", "host", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "approval_rules_user_id_kind_host_category_match_key_task_id_key" ON "approval_rules"("user_id", "kind", "host", "category", "match_key", "task_id", "conversation_id");

-- CreateIndex
CREATE INDEX "approval_rule_uses_rule_id_used_at_idx" ON "approval_rule_uses"("rule_id", "used_at");

-- AddForeignKey
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_rule_uses" ADD CONSTRAINT "approval_rule_uses_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "approval_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
