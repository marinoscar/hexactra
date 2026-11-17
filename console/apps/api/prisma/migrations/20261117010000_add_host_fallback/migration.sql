-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "host_fallback" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "host_fallback" BOOLEAN NOT NULL DEFAULT true;
