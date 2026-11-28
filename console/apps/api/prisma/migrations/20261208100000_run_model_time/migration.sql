-- E54.0 (#1081): how long a run waited for the model, and which models served it. Additive; existing runs get 0 and an empty list.
-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "model_ms" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "models" VARCHAR(160)[] DEFAULT ARRAY[]::VARCHAR(160)[];
