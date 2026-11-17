-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "active_ms" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "active_since" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "tasks" ALTER COLUMN "max_steps" SET DEFAULT 100,
ALTER COLUMN "max_minutes" SET DEFAULT 30;
