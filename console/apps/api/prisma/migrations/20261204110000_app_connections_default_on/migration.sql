-- E50.17 (#987): a tool that is set up and switched on is always available, an AI app's runs included, unless the owner turns connections
-- off for that app. A new app's `allow_connections` is on; an app saved before keeps the value it has (no row is updated).

-- AlterTable
ALTER TABLE "connected_app_settings" ALTER COLUMN "allow_connections" SET DEFAULT true;
