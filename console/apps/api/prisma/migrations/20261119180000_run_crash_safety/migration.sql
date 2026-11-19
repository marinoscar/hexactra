-- Crash safety of a run (E38.3, #584): the phase of a step that can commit something, the token of the job that holds a run, and
-- how many times a run was recovered after an interruption. No value of a secret is stored here.
-- AlterTable
ALTER TABLE "run_steps" ADD COLUMN "phase" VARCHAR(10) NOT NULL DEFAULT 'done';

-- AlterTable
ALTER TABLE "runs" ADD COLUMN "worker_token" VARCHAR(64),
ADD COLUMN "recoveries" INTEGER NOT NULL DEFAULT 0;
