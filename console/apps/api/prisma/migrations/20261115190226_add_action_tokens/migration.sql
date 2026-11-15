-- CreateTable
CREATE TABLE "action_tokens" (
    "id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "purpose" VARCHAR(40) NOT NULL,
    "issue_key" VARCHAR(120),
    "question_id" UUID,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "action_tokens_token_hash_key" ON "action_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "action_tokens_issue_key_key" ON "action_tokens"("issue_key");

-- CreateIndex
CREATE INDEX "action_tokens_expires_at_idx" ON "action_tokens"("expires_at");
