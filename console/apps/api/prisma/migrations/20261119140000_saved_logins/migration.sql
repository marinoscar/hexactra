-- Unattended sign-in from a saved login (E37.3, #592): the opt-ins and what a run records. No secret is stored here.
-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "use_saved_logins" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "unattended_payments" VARCHAR(8) NOT NULL DEFAULT 'ask';

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN "use_saved_logins" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "connected_app_settings" ADD COLUMN "allow_saved_logins" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "runs" ADD COLUMN "used_saved_logins" JSONB;
