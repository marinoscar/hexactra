// The db tier's leftover jobs (#912, #934): after each `*.db.spec.ts` file, every job it left `pending` is marked `failed`, and a leftover
// `browser.goal.run` job ends its run when the run is still live (`test/support/db-tier-leftovers.ts`).
//
// Why: the db specs share one database and run one after another (`--runInBand`). A spec that queues a job and does its own work leaves
// the job `pending` (specs queue `browser.goal.run` for every run they start, the Knowledge Graph specs `kgraph.*` after every run). The
// next spec that boots the app starts a job worker, which claims that stranger's job. One still running, or the fire-and-forget work a
// finished run starts, can query the database after that spec closed its app (the platform worker waits only 5 s) and Jest has torn the
// file down: "Cannot read properties of undefined (reading 'Socket')", failing CI after every test passed (#889, #912, #934).
//
// #912 cleared only `kgraph.*` jobs: failing every pending job once broke `secrets-vault`, because the leftover runs then stayed live and
// `dueUserIds` reads only the first 500 users with a live run. #934 clears every type and ends the leftover runs too, so no live run is
// left behind for a later spec either.
//
// A spec's own jobs are its own business while it runs; nothing here touches a job before the file is done. Unit specs (no database)
// are skipped. Test-only: the job queue's and the runner's behaviour in the app is unchanged.
import { buildDatabaseUrl } from '@marinoscar/platform-api/core';
import { Client } from 'pg';

import { clearLeftoverJobs } from './support/db-tier-leftovers';

const isDbSpec = (): boolean => /\.db\.spec\.ts$/.test(expect.getState().testPath ?? '');

afterAll(async () => {
  if (!isDbSpec()) return;
  const client = new Client({ connectionString: buildDatabaseUrl(process.env) });
  try {
    await client.connect();
    await clearLeftoverJobs(client);
  } catch {
    // Best effort: a spec that never reached the database, or a database already gone, has nothing to leave behind.
  } finally {
    await client.end().catch(() => undefined);
  }
});
