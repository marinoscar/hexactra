-- What a "Don't ask again" tick would remember (#555): { kind, host, category, matchKey, summary }, set by the server only.
ALTER TABLE "questions" ADD COLUMN "rememberable" JSONB;
