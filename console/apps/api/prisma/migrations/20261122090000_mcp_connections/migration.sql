-- MCP servers as connections (E39.9, #606): the server's URL and sign-in kind (`config`, never a secret) and the snapshot of the tools it
-- offered, with the owner's own switch per tool (off, read or write) and the hash that detects a changed tool.

-- AlterTable
ALTER TABLE "connections" ADD COLUMN "config" JSONB;

-- CreateTable
CREATE TABLE "connection_mcp_tools" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "title" VARCHAR(200),
    "description" TEXT NOT NULL DEFAULT '',
    "input_schema" JSONB NOT NULL,
    "annotations" JSONB NOT NULL DEFAULT '{}',
    "hash" VARCHAR(64) NOT NULL,
    "mode" VARCHAR(8) NOT NULL DEFAULT 'off',
    "suggested" VARCHAR(8) NOT NULL,
    "review" VARCHAR(8),
    "approved_hash" VARCHAR(64),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "connection_mcp_tools_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "connection_mcp_tools_connection_id_name_key" ON "connection_mcp_tools"("connection_id", "name");

-- CreateIndex
CREATE INDEX "connection_mcp_tools_connection_id_mode_idx" ON "connection_mcp_tools"("connection_id", "mode");

-- AddForeignKey
ALTER TABLE "connection_mcp_tools" ADD CONSTRAINT "connection_mcp_tools_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
