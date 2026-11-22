-- CreateTable
CREATE TABLE "kg_traces" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "tool" VARCHAR(64) NOT NULL,
    "family" VARCHAR(200) NOT NULL,
    "commits" BOOLEAN NOT NULL DEFAULT false,
    "bindings" JSONB NOT NULL DEFAULT '{}',
    "post" JSONB NOT NULL DEFAULT '{}',
    "ok" BOOLEAN NOT NULL,
    "outcome" VARCHAR(12) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kg_traces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kg_traces_user_id_run_id_seq_idx" ON "kg_traces"("user_id", "run_id", "seq");

-- AddForeignKey
ALTER TABLE "kg_traces" ADD CONSTRAINT "kg_traces_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_traces" ADD CONSTRAINT "kg_traces_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
