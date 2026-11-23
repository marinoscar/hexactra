// The db tier's leftover Knowledge Graph jobs: after each `*.db.spec.ts` file, `kgraph.*` jobs it left `pending` are marked `failed`, so
// the next file's job worker never picks them up.
//
// Why: the db specs share one database and run one after another (`--runInBand`). A spec that queues a job and does its work directly
// (the Knowledge Graph specs queue `kgraph.compile`, `kgraph.ledger.write` and `kgraph.site_facts` after every run they drive; others
// queue `browser.goal.run`) left that job for whichever later spec ran a worker. That spec then ran someone else's job, and one still
// running when it closed its app queried the database after Jest had torn the file down ("Cannot read properties of undefined (reading
// 'Socket')", "You are trying to `require` a file after the Jest environment has been torn down"), failing CI after every test had
// passed. #889 fixed one such spec by turning its worker off.
//
// Only the Knowledge Graph's own job types (`kgraph.*`, added by epic E46, which multiplied the leftovers) are cleared. Other leftovers,
// such as `browser.goal.run`, are left as before: later specs finishing them is what ends those runs, and some specs rely on there being
// few live runs (`dueUserIds` reads the first 500). A `kgraph.*` job never changes a run's status.
//
// A spec's own jobs are its own business while it runs; nothing here touches a job before the file is done. Unit specs (no database)
// are skipped. Test-only: the job queue's behaviour in the app is unchanged.
import { buildDatabaseUrl } from '@marinoscar/platform-api/core';
import { Client } from 'pg';

const isDbSpec = (): boolean => /\.db\.spec\.ts$/.test(expect.getState().testPath ?? '');

afterAll(async () => {
  if (!isDbSpec()) return;
  const client = new Client({ connectionString: buildDatabaseUrl(process.env) });
  try {
    await client.connect();
    await client.query(`UPDATE "jobs" SET "status" = 'failed' WHERE "status" = 'pending' AND "type" LIKE 'kgraph.%'`);
  } catch {
    // Best effort: a spec that never reached the database, or a database already gone, has nothing to leave behind.
  } finally {
    await client.end().catch(() => undefined);
  }
});
