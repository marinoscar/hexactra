-- E50.7 (#977): an AI app's runs get web search when the owner set it up and switched it on, unless the owner turns it off for that app.
-- On by default, for every app (a new one and one saved before).

-- AlterTable
ALTER TABLE "connected_app_settings" ADD COLUMN "allow_web_search" BOOLEAN NOT NULL DEFAULT true;
