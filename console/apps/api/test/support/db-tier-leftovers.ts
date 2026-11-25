// What a DB spec file leaves in the shared database for the next one (#934). Used by `test/db-tier-jobs.setup.ts` after every
// `*.db.spec.ts` file, and tested on its own by `db-tier-leftovers.db.spec.ts`. Test-only.
import type { Client } from 'pg';

/** The error a run ended by the cleanup carries: it names the cause, so a later spec reading runs can tell. */
export const LEFTOVER_RUN_ERROR = 'Ended by the test tier: its spec file finished with the run still queued (#934).';

/** The run statuses that count as live (`LIVE_RUN_STATUSES` in src/tasks/runs.schemas.ts). */
const LIVE = ['queued', 'running', 'waiting_human', 'paused'];

/**
 * Marks every job the file left `pending` as `failed`, whatever its type, so the next file's job worker never claims a stranger's job
 * that may still be querying when that file closes. A leftover `browser.goal.run` job also ends its run when the run is still live:
 * otherwise the run would stay live for good (no worker will ever run it), and specs that read the live runs (`dueUserIds` reads the
 * first 500) would see it. A `running` job and a run without a leftover job are not touched. Returns what it changed.
 */
export async function clearLeftoverJobs(client: Pick<Client, 'query'>): Promise<{ jobs: number; runs: number }> {
  const res = await client.query<{ jobs: string; runs: string }>(
    `WITH cleared AS (
       UPDATE "jobs" SET "status" = 'failed' WHERE "status" = 'pending'
       RETURNING "type", "subject_type", "subject_id"
     ), ended AS (
       UPDATE "runs" SET "status" = 'failed', "finished_at" = now(), "error" = $1
       WHERE "id"::text IN (SELECT "subject_id" FROM cleared WHERE "type" = 'browser.goal.run' AND "subject_type" = 'browser_run')
         AND "status"::text = ANY($2::text[])
       RETURNING "id"
     )
     SELECT (SELECT count(*) FROM cleared) AS jobs, (SELECT count(*) FROM ended) AS runs`,
    [LEFTOVER_RUN_ERROR, LIVE],
  );
  const row = res.rows[0];
  return { jobs: Number(row?.jobs ?? 0), runs: Number(row?.runs ?? 0) };
}
