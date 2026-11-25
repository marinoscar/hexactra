-- CreateTable
CREATE TABLE "profile_signin_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID,
    "host_id" UUID NOT NULL,
    "profile" VARCHAR(32) NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'started',
    "phase" VARCHAR(12) NOT NULL DEFAULT 'waiting',
    "lease_id" UUID,
    "viewer_session_id" UUID,
    "keep_lease" BOOLEAN NOT NULL DEFAULT false,
    "close_checked_at" VARCHAR(40),
    "close_sent_at" TIMESTAMPTZ,
    "result_state" VARCHAR(12),
    "end_reason" VARCHAR(20),
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ,

    CONSTRAINT "profile_signin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "profile_signin_sessions_status_started_at_idx" ON "profile_signin_sessions"("status", "started_at");

-- CreateIndex
CREATE INDEX "profile_signin_sessions_user_id_host_id_status_idx" ON "profile_signin_sessions"("user_id", "host_id", "status");

-- AddForeignKey
ALTER TABLE "profile_signin_sessions" ADD CONSTRAINT "profile_signin_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
