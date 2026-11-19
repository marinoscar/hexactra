-- CreateTable
CREATE TABLE "secrets_store_callback_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "secrets_store_callback_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "secrets_store_callback_tokens_token_hash_key" ON "secrets_store_callback_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "secrets_store_callback_tokens_user_id_idx" ON "secrets_store_callback_tokens"("user_id");

-- CreateIndex
CREATE INDEX "secrets_store_callback_tokens_expires_at_idx" ON "secrets_store_callback_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "secrets_store_callback_tokens" ADD CONSTRAINT "secrets_store_callback_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
