-- AlterTable
ALTER TABLE "connected_app_settings" ADD COLUMN     "confirm_sensitive_actions" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "mcp_activity" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" UUID NOT NULL,
    "org_id" UUID,
    "event" VARCHAR(32) NOT NULL DEFAULT 'tool_call',
    "credential_kind" VARCHAR(16) NOT NULL,
    "client_id" UUID,
    "client_name" VARCHAR(64),
    "grant_id" UUID,
    "tool" VARCHAR(64),
    "effect" VARCHAR(16),
    "run_id" UUID,
    "task_id" UUID,
    "session_id" UUID,
    "question_id" UUID,
    "outcome" VARCHAR(32) NOT NULL,
    "error_code" VARCHAR(64),
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "request_id" VARCHAR(100),
    "detail" JSONB,

    CONSTRAINT "mcp_activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcp_activity_user_id_created_at_idx" ON "mcp_activity"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "mcp_activity_client_id_created_at_idx" ON "mcp_activity"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "mcp_activity_created_at_idx" ON "mcp_activity"("created_at");

-- AddForeignKey
ALTER TABLE "mcp_activity" ADD CONSTRAINT "mcp_activity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
