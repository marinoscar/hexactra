-- AlterEnum
ALTER TYPE "question_input" ADD VALUE 'form';

-- AlterTable
ALTER TABLE "questions" ADD COLUMN     "fields" JSONB;

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "inputs" JSONB;

-- AlterTable
ALTER TABLE "task_schedules" ADD COLUMN     "inputs" JSONB;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "parameters" JSONB;
