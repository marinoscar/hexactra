-- Task outputs (E39.5, #600): the named values a run must return when it finishes. A task declares them (`tasks.outputs`); a run
-- copies the definitions when it starts (`runs.outputs_spec`) and stores what the agent returned (`runs.outputs`, validated on the server).
-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "outputs" JSONB;

-- AlterTable
ALTER TABLE "runs" ADD COLUMN "outputs_spec" JSONB,
ADD COLUMN "outputs" JSONB,
ADD COLUMN "outputs_complete" BOOLEAN;
