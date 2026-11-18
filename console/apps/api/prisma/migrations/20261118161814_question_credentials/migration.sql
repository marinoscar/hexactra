-- AlterEnum
ALTER TYPE "question_input" ADD VALUE 'credentials';

-- AlterTable
ALTER TABLE "questions" ADD COLUMN     "remember_label" VARCHAR(80);
