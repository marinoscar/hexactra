-- Secrets providers (E37.2, #591): the owner's connection to a Vault. No secret is stored here: tokens and the client secret are in the encrypted credential store.
-- CreateEnum
CREATE TYPE "secrets_connection_status" AS ENUM ('disconnected', 'connected', 'needs_reconnect');

-- CreateTable
CREATE TABLE "secrets_connections" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" VARCHAR(20) NOT NULL,
    "status" "secrets_connection_status" NOT NULL DEFAULT 'disconnected',
    "base_url" VARCHAR(2048),
    "client_id" VARCHAR(200),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "provider_user_id" VARCHAR(100),
    "agent_access" VARCHAR(10) NOT NULL DEFAULT 'unknown',
    "access_expires_at" TIMESTAMPTZ,
    "refresh_lease_until" TIMESTAMPTZ,
    "connected_at" TIMESTAMPTZ,
    "last_used_at" TIMESTAMPTZ,
    "last_success_at" TIMESTAMPTZ,
    "last_error_code" VARCHAR(60),
    "last_error_at" TIMESTAMPTZ,
    "reconnect_notified_at" TIMESTAMPTZ,
    "pending_state_hash" VARCHAR(64),
    "pending_binding_hash" VARCHAR(64),
    "pending_expires_at" TIMESTAMPTZ,
    "pending_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "secrets_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "secrets_connections_pending_state_hash_key" ON "secrets_connections"("pending_state_hash");

-- CreateIndex
CREATE INDEX "secrets_connections_status_idx" ON "secrets_connections"("status");

-- CreateIndex
CREATE UNIQUE INDEX "secrets_connections_user_id_provider_key" ON "secrets_connections"("user_id", "provider");

-- AddForeignKey
ALTER TABLE "secrets_connections" ADD CONSTRAINT "secrets_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
