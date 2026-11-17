-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "cached_input_tokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cost_known" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
ADD COLUMN     "model_calls" INTEGER NOT NULL DEFAULT 0;

-- Runs from before cost tracking used tokens that were never priced: their cost is unknown, not zero.
UPDATE "runs" SET "cost_known" = false WHERE "input_tokens" + "output_tokens" > 0;
