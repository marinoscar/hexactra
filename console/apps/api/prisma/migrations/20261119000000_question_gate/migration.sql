-- The commitment the confirmation gate stopped (#550): { host, category, label }, set by the server only.
ALTER TABLE "questions" ADD COLUMN "gate" JSONB;
