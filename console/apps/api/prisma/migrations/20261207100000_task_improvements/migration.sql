-- CreateTable
CREATE TABLE "task_improvements" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'queued',
    "run_ids" UUID[],
    "goal_before" VARCHAR(4000) NOT NULL,
    "proposed_goal" VARCHAR(4000),
    "summary" VARCHAR(1000),
    "changes" JSONB NOT NULL DEFAULT '[]',
    "site_facts" JSONB NOT NULL DEFAULT '[]',
    "confidence" VARCHAR(8),
    "model" VARCHAR(200),
    "used_images" BOOLEAN NOT NULL DEFAULT false,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(12,6),
    "error" VARCHAR(500),
    "applied_goal" VARCHAR(4000),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,
    "decided_at" TIMESTAMPTZ,

    CONSTRAINT "task_improvements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_improvements_user_id_task_id_created_at_idx" ON "task_improvements"("user_id", "task_id", "created_at");

-- AddForeignKey
ALTER TABLE "task_improvements" ADD CONSTRAINT "task_improvements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_improvements" ADD CONSTRAINT "task_improvements_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
