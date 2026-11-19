-- Connections (E39.2, #599): the owner's accounts at Google and Microsoft. No token is stored here: tokens live in the encrypted credential store.
-- CreateEnum
CREATE TYPE "connection_provider" AS ENUM ('google', 'microsoft', 'mcp');

-- CreateEnum
CREATE TYPE "connection_status" AS ENUM ('active', 'paused', 'needs_reconnect', 'revoked');

-- CreateTable
CREATE TABLE "connections" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "connection_provider" NOT NULL,
    "account_id" VARCHAR(255) NOT NULL,
    "account_email" VARCHAR(320) NOT NULL,
    "account_name" VARCHAR(200),
    "label" VARCHAR(60) NOT NULL,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "granted_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "default_for" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "connection_status" NOT NULL DEFAULT 'active',
    "status_reason" VARCHAR(60),
    "connected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ,
    "last_refresh_at" TIMESTAMPTZ,
    "access_expires_at" TIMESTAMPTZ,
    "refresh_lease_until" TIMESTAMPTZ,
    "reconnect_notified_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connection_flows" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "connection_provider" NOT NULL,
    "state_hash" VARCHAR(64) NOT NULL,
    "binding_hash" VARCHAR(64) NOT NULL,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "label" VARCHAR(60),
    "login_hint" VARCHAR(320),
    "connection_id" UUID,
    "return_to" VARCHAR(200) NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connection_flows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "connections_user_id_provider_status_idx" ON "connections"("user_id", "provider", "status");

-- CreateIndex
CREATE INDEX "connections_status_last_refresh_at_idx" ON "connections"("status", "last_refresh_at");

-- CreateIndex
CREATE UNIQUE INDEX "connections_user_id_provider_account_id_key" ON "connections"("user_id", "provider", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "connections_user_id_label_key" ON "connections"("user_id", "label");

-- CreateIndex
CREATE UNIQUE INDEX "connection_flows_state_hash_key" ON "connection_flows"("state_hash");

-- CreateIndex
CREATE INDEX "connection_flows_user_id_idx" ON "connection_flows"("user_id");

-- CreateIndex
CREATE INDEX "connection_flows_expires_at_idx" ON "connection_flows"("expires_at");

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_flows" ADD CONSTRAINT "connection_flows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_flows" ADD CONSTRAINT "connection_flows_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A default account is at most one per provider and capability group (mail, calendar, docs) per user. An array cannot carry a
-- unique index, so a trigger refuses a second claim (unique_violation); the service also serializes writers per user.
CREATE FUNCTION "connections_one_default_per_group"() RETURNS trigger AS $$
BEGIN
  IF cardinality(NEW."default_for") > 0 AND EXISTS (
    SELECT 1 FROM "connections" c
    WHERE c."user_id" = NEW."user_id" AND c."provider" = NEW."provider" AND c."id" <> NEW."id" AND c."default_for" && NEW."default_for"
  ) THEN
    RAISE EXCEPTION 'connections: a default for this provider and capability group already exists' USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "connections_one_default_per_group_trg"
BEFORE INSERT OR UPDATE OF "default_for", "provider", "user_id" ON "connections"
FOR EACH ROW EXECUTE FUNCTION "connections_one_default_per_group"();
