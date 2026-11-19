-- Mail triggers (E39.8, #605): a trigger accepts a sender the provider could not check only when the owner says so (off by default).
-- AlterTable
ALTER TABLE "mail_triggers" ADD COLUMN     "accept_unverified" BOOLEAN NOT NULL DEFAULT false;
