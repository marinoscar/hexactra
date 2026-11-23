-- E46.32 (#854): the site facts a run was given and the ones it used. Columns on a kg_ table only, with defaults: no existing row changes meaning.
-- AlterTable
ALTER TABLE "kg_runs" ADD COLUMN "offered_fact_ids" VARCHAR(200)[] DEFAULT ARRAY[]::VARCHAR(200)[],
ADD COLUMN "fact_ids" VARCHAR(200)[] DEFAULT ARRAY[]::VARCHAR(200)[];
