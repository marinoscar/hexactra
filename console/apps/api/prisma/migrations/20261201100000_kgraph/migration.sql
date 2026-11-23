-- CreateTable
CREATE TABLE "kg_task_settings" (
    "task_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "mode" VARCHAR(8) NOT NULL DEFAULT 'off',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "kg_task_settings_pkey" PRIMARY KEY ("task_id")
);

-- CreateTable
CREATE TABLE "kg_runs" (
    "run_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "mode" VARCHAR(8) NOT NULL DEFAULT 'off',
    "ai_only" BOOLEAN NOT NULL DEFAULT false,
    "procedure_version_id" VARCHAR(200),
    "outcome" VARCHAR(32),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "kg_runs_pkey" PRIMARY KEY ("run_id")
);

-- CreateTable
CREATE TABLE "kg_nodes" (
    "id" VARCHAR(200) NOT NULL,
    "user_id" UUID NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "key" VARCHAR(500) NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "props" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "kg_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kg_edges" (
    "id" VARCHAR(200) NOT NULL,
    "user_id" UUID NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "from_id" VARCHAR(200) NOT NULL,
    "to_id" VARCHAR(200) NOT NULL,
    "props" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kg_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kg_procedures" (
    "id" VARCHAR(200) NOT NULL,
    "user_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "active_version_id" VARCHAR(200),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "kg_procedures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kg_procedure_versions" (
    "id" VARCHAR(200) NOT NULL,
    "user_id" UUID NOT NULL,
    "procedure_id" VARCHAR(200) NOT NULL,
    "seq" INTEGER NOT NULL,
    "state" VARCHAR(12) NOT NULL,
    "graph" JSONB NOT NULL,
    "change_class" VARCHAR(12) NOT NULL,
    "source_run_id" VARCHAR(200),
    "parent_version_id" VARCHAR(200),
    "created_at" TIMESTAMPTZ NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "kg_procedure_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kg_evidence" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "version_id" VARCHAR(200) NOT NULL,
    "step_id" VARCHAR(200) NOT NULL DEFAULT '',
    "successes" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "repairs" INTEGER NOT NULL DEFAULT 0,
    "last_success_at" TIMESTAMPTZ,
    "last_failure_at" TIMESTAMPTZ,

    CONSTRAINT "kg_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kg_reviews" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "version_id" VARCHAR(200) NOT NULL,
    "summary" JSONB NOT NULL DEFAULT '[]',
    "status" VARCHAR(12) NOT NULL DEFAULT 'pending',
    "question_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "kg_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kg_task_settings_user_id_idx" ON "kg_task_settings"("user_id");

-- CreateIndex
CREATE INDEX "kg_runs_user_id_created_at_idx" ON "kg_runs"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "kg_nodes_user_id_type_key_key" ON "kg_nodes"("user_id", "type", "key");

-- CreateIndex
CREATE INDEX "kg_edges_user_id_from_id_type_idx" ON "kg_edges"("user_id", "from_id", "type");

-- CreateIndex
CREATE INDEX "kg_edges_user_id_to_id_type_idx" ON "kg_edges"("user_id", "to_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "kg_procedures_user_id_task_id_key" ON "kg_procedures"("user_id", "task_id");

-- CreateIndex
CREATE INDEX "kg_procedure_versions_user_id_procedure_id_idx" ON "kg_procedure_versions"("user_id", "procedure_id");

-- CreateIndex
CREATE UNIQUE INDEX "kg_procedure_versions_procedure_id_seq_key" ON "kg_procedure_versions"("procedure_id", "seq");

-- CreateIndex
CREATE INDEX "kg_evidence_user_id_version_id_idx" ON "kg_evidence"("user_id", "version_id");

-- CreateIndex
CREATE UNIQUE INDEX "kg_evidence_version_id_step_id_key" ON "kg_evidence"("version_id", "step_id");

-- CreateIndex
CREATE INDEX "kg_reviews_user_id_status_idx" ON "kg_reviews"("user_id", "status");

-- AddForeignKey
ALTER TABLE "kg_task_settings" ADD CONSTRAINT "kg_task_settings_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_task_settings" ADD CONSTRAINT "kg_task_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_runs" ADD CONSTRAINT "kg_runs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_runs" ADD CONSTRAINT "kg_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_nodes" ADD CONSTRAINT "kg_nodes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_edges" ADD CONSTRAINT "kg_edges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_procedures" ADD CONSTRAINT "kg_procedures_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_procedures" ADD CONSTRAINT "kg_procedures_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_procedure_versions" ADD CONSTRAINT "kg_procedure_versions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_procedure_versions" ADD CONSTRAINT "kg_procedure_versions_procedure_id_fkey" FOREIGN KEY ("procedure_id") REFERENCES "kg_procedures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_evidence" ADD CONSTRAINT "kg_evidence_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_evidence" ADD CONSTRAINT "kg_evidence_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "kg_procedure_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_reviews" ADD CONSTRAINT "kg_reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
