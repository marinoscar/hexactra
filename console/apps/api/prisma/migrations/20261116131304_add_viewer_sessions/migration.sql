-- CreateTable
CREATE TABLE "viewer_sessions" (
    "id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "host_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "last_connect_at" TIMESTAMPTZ,

    CONSTRAINT "viewer_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "viewer_sessions_token_hash_key" ON "viewer_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "viewer_sessions_expires_at_idx" ON "viewer_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "viewer_sessions_user_id_host_id_idx" ON "viewer_sessions"("user_id", "host_id");
