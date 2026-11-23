-- CreateTable
CREATE TABLE "kg_site_facts" (
    "id" VARCHAR(200) NOT NULL,
    "user_id" UUID NOT NULL,
    "site" VARCHAR(253) NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "text" VARCHAR(300) NOT NULL,
    "identity" TEXT NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'proposed',
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "declined_at" TIMESTAMPTZ,
    "last_used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "kg_site_facts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kg_site_facts_user_id_site_status_idx" ON "kg_site_facts"("user_id", "site", "status");

-- CreateIndex
CREATE UNIQUE INDEX "kg_site_facts_user_id_identity_key" ON "kg_site_facts"("user_id", "identity");

-- AddForeignKey
ALTER TABLE "kg_site_facts" ADD CONSTRAINT "kg_site_facts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
