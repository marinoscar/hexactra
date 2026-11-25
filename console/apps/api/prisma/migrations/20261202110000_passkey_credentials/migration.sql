-- CreateTable
CREATE TABLE "passkey_credentials" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "rp_id" VARCHAR(253) NOT NULL,
    "origin" VARCHAR(2048) NOT NULL,
    "credential_id" VARCHAR(1024) NOT NULL,
    "user_handle" VARCHAR(1024) NOT NULL,
    "user_name" VARCHAR(200) NOT NULL DEFAULT '',
    "public_key" VARCHAR(1024) NOT NULL,
    "key_ciphertext" TEXT NOT NULL,
    "key_iv" VARCHAR(32) NOT NULL,
    "key_auth_tag" VARCHAR(32) NOT NULL,
    "sign_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ,
    "created_by_run_id" VARCHAR(100),

    CONSTRAINT "passkey_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "passkey_credentials_owner_user_id_rp_id_idx" ON "passkey_credentials"("owner_user_id", "rp_id");

-- CreateIndex
CREATE UNIQUE INDEX "passkey_credentials_owner_user_id_rp_id_credential_id_key" ON "passkey_credentials"("owner_user_id", "rp_id", "credential_id");

-- AddForeignKey
ALTER TABLE "passkey_credentials" ADD CONSTRAINT "passkey_credentials_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
