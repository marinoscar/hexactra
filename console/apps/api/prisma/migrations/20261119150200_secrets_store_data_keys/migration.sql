-- CreateTable
CREATE TABLE "secrets_store_data_keys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "key_id" VARCHAR(16) NOT NULL,
    "wrapped" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rewrapped_at" TIMESTAMPTZ,

    CONSTRAINT "secrets_store_data_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "secrets_store_data_keys_user_id_key" ON "secrets_store_data_keys"("user_id");

-- CreateIndex
CREATE INDEX "secrets_store_data_keys_key_id_idx" ON "secrets_store_data_keys"("key_id");

-- AddForeignKey
ALTER TABLE "secrets_store_data_keys" ADD CONSTRAINT "secrets_store_data_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
