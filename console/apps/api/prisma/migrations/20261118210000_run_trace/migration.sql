-- AlterTable
ALTER TABLE "run_steps" ADD COLUMN     "question_id" UUID,
ADD COLUMN     "screenshot_masked" INTEGER,
ADD COLUMN     "screenshot_moment" VARCHAR(24),
ADD COLUMN     "screenshot_note" VARCHAR(24);

-- CreateIndex
CREATE INDEX "run_steps_question_id_idx" ON "run_steps"("question_id");

-- AddForeignKey
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
