-- Payment cards the agent pays with under the owner's per-merchant approval and amount limit (E37.7, #596): the opt-ins, what a
-- run records, and the card a saved approval is bound to. No card data is stored here: a run records a brand, the last four and amounts.
-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "use_saved_cards" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN "use_saved_cards" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "connected_app_settings" ADD COLUMN "allow_saved_cards" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "runs" ADD COLUMN "used_saved_cards" JSONB;

-- AlterTable: a saved approval for a card is bound to the card; every other rule keeps the empty reference.
ALTER TABLE "approval_rules" ADD COLUMN "card_ref" VARCHAR(200) NOT NULL DEFAULT '';

-- The unique key now includes the card.
DROP INDEX "approval_rules_user_id_kind_host_category_match_key_task_id_key";
CREATE UNIQUE INDEX "approval_rules_user_id_kind_host_category_match_key_task_id_key" ON "approval_rules"("user_id", "kind", "host", "category", "match_key", "task_id", "conversation_id", "card_ref");

-- AlterTable: a card field's activity row names the declared purchase and the payment frame's host (E37.7). Never a value.
ALTER TABLE "secrets_activity" ADD COLUMN "amount" VARCHAR(16),
ADD COLUMN "currency" VARCHAR(3),
ADD COLUMN "frame_site" VARCHAR(255);
