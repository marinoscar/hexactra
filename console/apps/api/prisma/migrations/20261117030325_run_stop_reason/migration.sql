-- CreateEnum
CREATE TYPE "run_stop_reason" AS ENUM ('finished', 'budget_actions', 'budget_model_calls', 'budget_active_time', 'budget_input_tokens', 'budget_output_tokens', 'budget_cost', 'stalled', 'cancelled', 'error', 'no_model');

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "stop_reason" "run_stop_reason";
