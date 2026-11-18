-- CreateEnum
CREATE TYPE "memory_kind" AS ENUM ('person', 'account', 'preference', 'fact');

-- CreateEnum
CREATE TYPE "memory_status" AS ENUM ('active', 'superseded', 'archived');

-- CreateEnum
CREATE TYPE "memory_source" AS ENUM ('owner', 'agent_proposed');

-- CreateTable
CREATE TABLE "memories" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "memory_kind" NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attributes" JSONB NOT NULL,
    "note" VARCHAR(1000),
    "status" "memory_status" NOT NULL DEFAULT 'active',
    "source" "memory_source" NOT NULL,
    "source_run_id" UUID,
    "source_conversation_id" UUID,
    "superseded_by_id" UUID,
    "last_used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memories_user_id_status_kind_idx" ON "memories"("user_id", "status", "kind");

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
