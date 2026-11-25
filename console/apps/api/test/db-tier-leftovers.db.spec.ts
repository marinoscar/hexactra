// The db tier's cleanup between spec files (#934): every job a file left `pending` is failed, and a leftover goal-run job ends its live
// run, so the next file's worker never runs a stranger's job and no live run is left behind. `test/db-tier-jobs.setup.ts` calls it after
// every db spec file; this spec calls it directly.
import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { buildDatabaseUrl } from '@marinoscar/platform-api/core';
import { Client } from 'pg';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { clearLeftoverJobs, LEFTOVER_RUN_ERROR } from './support/db-tier-leftovers';

let app: NestFastifyApplication;
let prisma: PrismaService;
let client: Client;
const stamp = `${Date.now()}`;
// No job worker: this spec plants pending jobs and must be the only one to touch them.
const workerMode = process.env.JOBS_WORKER_MODE;

beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  client = new Client({ connectionString: buildDatabaseUrl(process.env) });
  await client.connect();
});
afterAll(async () => {
  await client?.end().catch(() => undefined);
  await app?.close();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
});

async function userId(): Promise<string> {
  const email = `db-tier-leftovers-${stamp}@example.test`;
  await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  return (await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id;
}

async function job(type: string, status: 'pending' | 'running', subject?: { type: string; id: string }): Promise<string> {
  const id = randomUUID();
  await client.query(`INSERT INTO "jobs" ("id", "type", "status", "reason", "subject_type", "subject_id", "dedup_key") VALUES ($1, $2, $3, 'test', $4, $5, $6)`, [id, type, status, subject?.type ?? null, subject?.id ?? null, `db-tier-leftovers:${id}`]);
  return id;
}

const jobStatus = async (id: string) => (await client.query<{ status: string }>(`SELECT "status" FROM "jobs" WHERE "id" = $1`, [id])).rows[0]?.status;

describe('the db tier clears what a spec file left behind (#934)', () => {
  it('fails every pending job and ends the live run of a leftover goal-run job; leaves the rest alone', async () => {
    const owner = await userId();
    const run = (status: 'queued' | 'running' | 'succeeded') => prisma.run.create({ data: { userId: owner, goal: `Leftover ${stamp}`, status }, select: { id: true } });
    const leftover = await run('queued');
    const finished = await run('succeeded');
    const noJob = await run('running');

    const goalJob = await job('browser.goal.run', 'pending', { type: 'browser_run', id: leftover.id });
    const finishedJob = await job('browser.goal.run', 'pending', { type: 'browser_run', id: finished.id });
    const otherJob = await job('deliveries.send', 'pending');
    const runningJob = await job('browser.goal.run', 'running', { type: 'browser_run', id: noJob.id });

    const changed = await clearLeftoverJobs(client);
    expect(changed.jobs).toBeGreaterThanOrEqual(3);
    expect(changed.runs).toBeGreaterThanOrEqual(1);

    // Every pending job, whatever its type, is failed; a running one is not touched.
    expect([await jobStatus(goalJob), await jobStatus(finishedJob), await jobStatus(otherJob), await jobStatus(runningJob)]).toEqual(['failed', 'failed', 'failed', 'running']);
    // The leftover job's live run is ended, with the cause; a finished run and a run without a leftover pending job keep their status.
    const after = await prisma.run.findMany({ where: { id: { in: [leftover.id, finished.id, noJob.id] } }, select: { id: true, status: true, error: true, finishedAt: true } });
    const byId = new Map(after.map((r) => [r.id, r]));
    expect(byId.get(leftover.id)).toMatchObject({ status: 'failed', error: LEFTOVER_RUN_ERROR });
    expect(byId.get(leftover.id)!.finishedAt).toBeInstanceOf(Date);
    expect(byId.get(finished.id)).toMatchObject({ status: 'succeeded', error: null });
    expect(byId.get(noJob.id)).toMatchObject({ status: 'running', error: null });

    // Clean up this spec's own running job: no later worker should claim it.
    await client.query(`UPDATE "jobs" SET "status" = 'failed' WHERE "id" = $1`, [runningJob]);
  });

  it('with nothing left behind it changes nothing', async () => {
    await clearLeftoverJobs(client);
    expect(await clearLeftoverJobs(client)).toEqual({ jobs: 0, runs: 0 });
  });
});
