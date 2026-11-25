-- AlterEnum
ALTER TYPE "question_input" ADD VALUE 'scan';

-- AlterTable
ALTER TABLE "questions" ADD COLUMN     "scan" JSONB;
