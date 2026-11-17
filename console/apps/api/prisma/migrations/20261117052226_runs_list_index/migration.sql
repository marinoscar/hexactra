-- CreateIndex
CREATE INDEX "runs_user_id_status_created_at_idx" ON "runs"("user_id", "status", "created_at");
