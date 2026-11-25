-- E48.5 (#931): a takeover asked on Google's account sign-in page links to the guided sign-in of the run's host and profile:
-- `{ hostId, profile }`, set by the server from the page URL the fabric reports. Null for every other question (and every earlier one).

-- AlterTable
ALTER TABLE "questions" ADD COLUMN "signin" JSONB;
