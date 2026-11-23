-- E46.28 (#850): the everyday mode. A procedure run inside a chat or one-off run (no saved task) gets a ledger row without a task, and the
-- run's Knowledge Graph facts count the procedure steps it replayed. kg_ tables only.

-- AlterTable
ALTER TABLE "kg_ledger" ALTER COLUMN "task_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "kg_runs" ADD COLUMN "steps_replayed" INTEGER NOT NULL DEFAULT 0;
