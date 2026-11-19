-- Agent tools for connections (E39.7, #604): which connections a task or a chat may use and how, whether a task needs a browser,
-- the `connection` saved-approval kind with its approved recipients, the question a connection call waits on, and the AI-app switch.

-- The saved-approval kind for calls through a connection (keyed on the connection and the tool, with no site).
ALTER TYPE "approval_rule_kind" ADD VALUE IF NOT EXISTS 'connection';

-- AlterTable
ALTER TABLE "approval_rules" ADD COLUMN "recipients" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "questions" ADD COLUMN "action" JSONB;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "needs_browser" VARCHAR(8) NOT NULL DEFAULT 'auto';

-- AlterTable
ALTER TABLE "connected_app_settings" ADD COLUMN "allow_connections" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "task_connections" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "access" VARCHAR(10) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_connections" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "access" VARCHAR(10) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "task_connections_task_id_connection_id_key" ON "task_connections"("task_id", "connection_id");

-- CreateIndex
CREATE INDEX "task_connections_connection_id_idx" ON "task_connections"("connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_connections_conversation_id_connection_id_key" ON "conversation_connections"("conversation_id", "connection_id");

-- CreateIndex
CREATE INDEX "conversation_connections_connection_id_idx" ON "conversation_connections"("connection_id");

-- AddForeignKey
ALTER TABLE "task_connections" ADD CONSTRAINT "task_connections_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_connections" ADD CONSTRAINT "task_connections_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_connections" ADD CONSTRAINT "conversation_connections_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_connections" ADD CONSTRAINT "conversation_connections_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
