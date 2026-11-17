// The db tier: deleting runs (#421) against a real, migrated and seeded
// database: one run, a list of ids, every finished run that matches a filter
// (in the request, or through the `browser.runs.delete` job), and what a
// deleted run takes with it.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Job } from '@marinoscar/platform-api/jobs';
import type { Prisma } from '@prisma/client';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { SchedulesService } from '../src/schedules/schedules.service';
import { RunsDeleteHandler } from '../src/tasks/run-delete.job';
import { RUNS_DELETE_JOB, RunDeleteService } from '../src/tasks/run-delete.service';
import { TasksService } from '../src/tasks/tasks.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
let service: RunDeleteService;
const stamp = `${Date.now()}`;
/** The storage port, replaced per test. */
const store = { delete: jest.fn(async (_key: string): Promise<void> => undefined) };

// No job worker in this app: the test runs the delete job itself, at a known moment.
const workerMode = process.env.JOBS_WORKER_MODE;
beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
  prisma = app.get(PrismaService);
  service = app.get(RunDeleteService, { strict: false });
  Object.assign(service, { store });
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  store.delete.mockReset();
  store.delete.mockResolvedValue(undefined);
});

type Session = { token: string; userId: string };
async function login(name: string, role: 'contributor' | 'viewer' = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}

interface Reply<T> {
  statusCode: number;
  code?: string;
  data: T;
  details?: Record<string, unknown>;
}
async function call<T = unknown>(s: Session, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown): Promise<Reply<T>> {
  const res = await app.inject({ method, url: `/api${url}`, headers: { authorization: `Bearer ${s.token}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const body = res.body ? res.json<{ data?: T; code?: string; details?: Record<string, unknown>; error?: { code?: string } }>() : {};
  return { statusCode: res.statusCode, code: body.code ?? body.error?.code, data: body.data as T, details: body.details };
}

interface Deleted {
  deleted: number;
  costUsd: number | null;
  skippedLive: string[];
  notFound: string[];
}
interface Queued {
  jobId: string;
  matched: number;
  costUsd: number | null;
}

const sorted = (v: string[]) => [...v].sort();
type RunInput = Omit<Prisma.RunCreateManyInput, 'userId' | 'goal'> & { goal?: string };
async function run(userId: string, data: RunInput = {}): Promise<string> {
  const row = await prisma.run.create({ data: { goal: 'Check the fare', status: 'succeeded', ...data, userId } as Prisma.RunUncheckedCreateInput, select: { id: true } });
  return row.id;
}
async function question(userId: string, runId: string, status: 'pending' | 'answered' | 'cancelled' = 'answered'): Promise<string> {
  const q = await prisma.question.create({ data: { ownerUserId: userId, askedBy: `run:${runId}`, runId, prompt: 'Which fare?', status, expiresAt: new Date(Date.now() + 3_600_000) }, select: { id: true } });
  return q.id;
}
const exists = async (id: string) => (await prisma.run.count({ where: { id } })) === 1;

describe('DELETE /runs/:id', () => {
  it('removes the run, its steps and its questions; a second call is 404', async () => {
    const user = await login('one');
    const keep = await run(user.userId);
    const id = await run(user.userId, { status: 'failed', stopReason: 'error' });
    await prisma.runStep.createMany({ data: [1, 2, 3].map((seq) => ({ runId: id, seq, kind: 'action', action: 'click', summary: `step ${seq}` })) });
    await prisma.runStep.create({ data: { runId: keep, seq: 1, kind: 'note' } });
    const q = await question(user.userId, id);
    const other = await question(user.userId, keep);

    const res = await app.inject({ method: 'DELETE', url: `/api/runs/${id}`, headers: { authorization: `Bearer ${user.token}` } });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(await exists(id)).toBe(false);
    expect(await prisma.runStep.count({ where: { runId: id } })).toBe(0);
    expect(await prisma.question.count({ where: { id: q } })).toBe(0);
    // Its neighbour is untouched.
    expect(await exists(keep)).toBe(true);
    expect(await prisma.runStep.count({ where: { runId: keep } })).toBe(1);
    expect(await prisma.question.count({ where: { id: other } })).toBe(1);

    expect(await call(user, 'DELETE', `/runs/${id}`)).toMatchObject({ statusCode: 404, code: 'RUN_NOT_FOUND' });
    expect(await call(user, 'GET', `/runs/${id}`)).toMatchObject({ statusCode: 404, code: 'RUN_NOT_FOUND' });
    expect((await call(user, 'DELETE', '/runs/not-a-uuid')).statusCode).toBe(400);
  });

  it.each(['queued', 'running', 'waiting_human'] as const)('refuses a %s run with 409 RUN_LIVE, and bulk delete skips it', async (status) => {
    const user = await login(`live-${status}`);
    const live = await run(user.userId, { status });
    const done = await run(user.userId);
    const single = await call(user, 'DELETE', `/runs/${live}`);
    expect(single).toMatchObject({ statusCode: 409, code: 'RUN_LIVE' });
    expect(await exists(live)).toBe(true);

    const bulk = await call<Deleted>(user, 'POST', '/runs/delete', { ids: [live, done] });
    expect(bulk.statusCode).toBe(200);
    expect(bulk.data).toEqual({ deleted: 1, costUsd: null, skippedLive: [live], notFound: [] });
    expect(await exists(live)).toBe(true);
    expect(await exists(done)).toBe(false);
  });

  it("a deleted run's cancelled questions are gone, and the inbox and the questions list still load", async () => {
    const user = await login('inbox');
    const tasks = app.get(TasksService, { strict: false });
    const id = await run(user.userId, { status: 'waiting_human' });
    const pending = await question(user.userId, id, 'pending');
    const elsewhere = await question(user.userId, await run(user.userId, { status: 'waiting_human' }), 'pending');
    expect((await call<{ questionId: string }[]>(user, 'GET', '/inbox')).data.map((i) => i.questionId).sort()).toEqual(sorted([pending, elsewhere]));

    // Cancelling the run withdraws its pending question (pending -> cancelled) ...
    await tasks.transition(user.userId, id, 'cancelled', { stopReason: 'cancelled' });
    expect((await prisma.question.findUniqueOrThrow({ where: { id: pending } })).status).toBe('cancelled');
    // ... and deleting the run removes it.
    expect((await call(user, 'DELETE', `/runs/${id}`)).statusCode).toBe(204);
    expect(await prisma.question.count({ where: { id: pending } })).toBe(0);

    const inbox = await call<{ questionId: string }[]>(user, 'GET', '/inbox');
    expect(inbox.statusCode).toBe(200);
    expect(inbox.data.map((i) => i.questionId)).toEqual([elsewhere]);
    expect((await call(user, 'GET', '/questions')).statusCode).toBe(200);
    expect((await call(user, 'GET', `/questions/${pending}`)).statusCode).toBe(404);
  });
});

describe('POST /runs/delete with ids', () => {
  it('sorts own, foreign, missing and live ids into deleted, notFound and skippedLive', async () => {
    const user = await login('ids');
    const other = await login('ids-other');
    const own = [await run(user.userId, { modelCalls: 3, costUsd: '1.25' }), await run(user.userId, { status: 'cancelled', modelCalls: 1, costUsd: '0.5' }), await run(user.userId, { status: 'failed' })];
    const live = [await run(user.userId, { status: 'queued' }), await run(user.userId, { status: 'running' })];
    const foreign = await run(other.userId);
    const missing = randomUUID();

    const res = await call<Deleted>(user, 'POST', '/runs/delete', { ids: [...own, ...live, foreign, missing] });
    expect(res.statusCode).toBe(200);
    expect(res.data.deleted).toBe(3);
    expect(res.data.costUsd).toBe(1.75);
    expect(sorted(res.data.skippedLive)).toEqual(sorted(live));
    // Another user's run reads exactly like one that does not exist.
    expect(sorted(res.data.notFound)).toEqual(sorted([foreign, missing]));
    for (const id of own) expect(await exists(id)).toBe(false);
    for (const id of [...live, foreign]) expect(await exists(id)).toBe(true);

    // Deleting them again: nothing is left to delete.
    expect((await call<Deleted>(user, 'POST', '/runs/delete', { ids: own })).data).toEqual({ deleted: 0, costUsd: null, skippedLive: [], notFound: expect.arrayContaining(own) });
  });

  it('validates the body: one of ids or filter, 1 to 500 unique uuids, no unknown key', async () => {
    const user = await login('body');
    const id = await run(user.userId);
    const bad: unknown[] = [
      {},
      { ids: [] },
      { ids: [id, id] },
      { ids: ['nope'] },
      { ids: Array.from({ length: 501 }, () => randomUUID()) },
      { ids: [id], filter: { status: 'failed' } },
      { ids: [id], expectedCount: 1 },
      { ids: [id], everything: true },
      { filter: { status: 'done' } },
      // A misspelt filter key is refused, never ignored (it would widen the delete).
      { filter: { taskID: randomUUID() }, expectedCount: 1 },
      { filter: { status: 'failed' }, expectedCount: -1 },
      { filter: { status: 'failed' }, expectedCount: 1.5 },
    ];
    for (const payload of bad) expect({ payload, statusCode: (await call(user, 'POST', '/runs/delete', payload)).statusCode }).toEqual({ payload, statusCode: 400 });
    // A filter that contradicts itself is the list's own error.
    expect(await call(user, 'POST', '/runs/delete', { filter: { status: 'failed', state: 'finished' } })).toMatchObject({ statusCode: 400, code: 'INVALID_FILTER' });
    expect(await exists(id)).toBe(true);
    expect((await call<Deleted>(user, 'POST', '/runs/delete', { ids: [...Array.from({ length: 499 }, () => randomUUID()), id] })).data.deleted).toBe(1);
  });
});

describe('POST /runs/delete with a filter', () => {
  it('deletes exactly the rows GET /runs lists for the same filter and state=finished', async () => {
    const user = await login('filter');
    const taskA = (await prisma.task.create({ data: { userId: user.userId, name: 'Fare check', goal: 'Find a fare' } })).id;
    const taskB = (await prisma.task.create({ data: { userId: user.userId, name: 'Inbox sweep', goal: 'Sweep' } })).id;
    const day = (n: number) => new Date(Date.parse('2026-06-01T12:00:00.000Z') + n * 86_400_000);
    for (let n = 0; n < 24; n++) {
      await run(user.userId, {
        taskId: n % 3 === 0 ? taskB : n % 3 === 1 ? taskA : null,
        status: (['succeeded', 'failed', 'cancelled', 'queued', 'running', 'waiting_human'] as const)[n % 6],
        trigger: n % 2 ? 'schedule' : 'manual',
        goal: n % 4 === 0 ? `Find a fare to city ${n}` : `Sweep ${n}`,
        stopReason: n % 6 === 1 ? 'budget_cost' : null,
        policyRef: n % 5 === 0 ? 'builtin:economy' : null,
        modelCalls: 1,
        costUsd: '0.1',
        createdAt: day(n),
      });
    }
    const listed = async (query: string) => sorted((await call<{ id: string }[]>(user, 'GET', `/runs?limit=200&${query}`)).data.map((r) => r.id));
    const all = () => listed('');

    const cases: { filter: Record<string, unknown>; query: string }[] = [
      { filter: { taskId: taskA, trigger: ['schedule'] }, query: `taskId=${taskA}&trigger=schedule` },
      { filter: { q: 'FARE' }, query: 'q=FARE' },
      { filter: { stopReason: 'budget', from: day(6).toISOString(), to: day(20).toISOString() }, query: `stopReason=budget&from=${encodeURIComponent(day(6).toISOString())}&to=${encodeURIComponent(day(20).toISOString())}` },
      { filter: { policyId: 'builtin:economy' }, query: 'policyId=builtin:economy' },
      { filter: { taskId: 'none' }, query: 'taskId=none' },
      // A status list that names live statuses is narrowed to its finished part, not rejected.
      { filter: { status: 'failed,queued,running' }, query: 'status=failed' },
    ];
    for (const c of cases) {
      const before = await all();
      const expected = await listed(`${c.query}${c.query.includes('status=') ? '' : '&state=finished'}`);
      const res = await call<Deleted>(user, 'POST', '/runs/delete', { filter: c.filter });
      expect({ filter: c.filter, statusCode: res.statusCode }).toEqual({ filter: c.filter, statusCode: 200 });
      expect(res.data).toEqual({ deleted: expected.length, costUsd: expected.length ? Number((expected.length * 0.1).toFixed(6)) : null, skippedLive: [], notFound: [] });
      expect(await all()).toEqual(before.filter((id) => !expected.includes(id)));
    }
    // state=live matches no finished run: nothing is deleted, nothing is an error.
    expect((await call<Deleted>(user, 'POST', '/runs/delete', { filter: { state: 'live' } })).data).toMatchObject({ deleted: 0 });
    // Every live run is still there.
    expect(await listed('state=live')).toHaveLength(12);
  });

  it('refuses a count more than 5 % from expectedCount with 409 COUNT_CHANGED, and an unbounded filter without it', async () => {
    const user = await login('count');
    const task = (await prisma.task.create({ data: { userId: user.userId, name: 'T', goal: 'g' } })).id;
    await prisma.run.createMany({ data: Array.from({ length: 40 }, () => ({ userId: user.userId, taskId: task, goal: 'g', status: 'succeeded' as const })) });
    await run(user.userId, { status: 'running', taskId: task });
    const count = () => prisma.run.count({ where: { userId: user.userId } });

    for (const expectedCount of [0, 20, 37, 43, 400]) {
      const res = await call(user, 'POST', '/runs/delete', { filter: { taskId: task }, expectedCount });
      expect(res).toMatchObject({ statusCode: 409, code: 'COUNT_CHANGED', details: { matched: 40, expectedCount } });
    }
    expect(await count()).toBe(41);

    // "All my finished runs" is allowed only with the count the caller saw.
    for (const filter of [{}, { state: 'finished' }, { status: ['succeeded', 'failed', 'cancelled'] }, { status: 'cancelled,failed,succeeded,queued' }]) {
      expect({ filter, statusCode: (await call(user, 'POST', '/runs/delete', { filter })).statusCode }).toEqual({ filter, statusCode: 400 });
    }
    expect(await count()).toBe(41);

    // Within 5 %: 39 and 42 both accept 40.
    const ok = await call<Deleted>(user, 'POST', '/runs/delete', { filter: {}, expectedCount: 42 });
    expect(ok).toMatchObject({ statusCode: 200, data: { deleted: 40, skippedLive: [], notFound: [] } });
    // The live run was never part of it.
    expect(await count()).toBe(1);
    expect((await call<Deleted>(user, 'POST', '/runs/delete', { filter: {}, expectedCount: 0 })).data.deleted).toBe(0);
  });

  it('hands more than 500 matches to the browser.runs.delete job, which leaves later runs alone', async () => {
    const user = await login('bulk');
    const bystander = await login('bulk-bystander');
    const task = (await prisma.task.create({ data: { userId: user.userId, name: 'Nightly', goal: 'g' } })).id;
    const ids = Array.from({ length: 1200 }, () => randomUUID());
    await prisma.run.createMany({ data: ids.map((id, n) => ({ id, userId: user.userId, taskId: task, goal: `Nightly ${n}`, status: (['succeeded', 'failed', 'cancelled'] as const)[n % 3], modelCalls: 2, costUsd: '0.01' })) });
    await prisma.runStep.createMany({ data: ids.flatMap((runId) => [1, 2].map((seq) => ({ runId, seq, kind: 'action', summary: 'step' }))) });
    await prisma.question.createMany({ data: ids.filter((_, n) => n % 4 === 0).map((runId) => ({ ownerUserId: user.userId, askedBy: `run:${runId}`, runId, prompt: 'Which?', status: 'answered' as const, expiresAt: new Date(Date.now() + 3_600_000) })) });
    const live = await run(user.userId, { status: 'running', taskId: task });
    const theirs = await run(bystander.userId);
    const tally = async () => ({
      runs: await prisma.run.count({ where: { userId: user.userId } }),
      run_steps: await prisma.runStep.count({ where: { run: { userId: user.userId } } }),
      questions: await prisma.question.count({ where: { ownerUserId: user.userId } }),
    });
    const before = await tally();
    expect(before).toEqual({ runs: 1201, run_steps: 2400, questions: 300 });

    const res = await call<Queued>(user, 'POST', '/runs/delete', { filter: { taskId: task }, expectedCount: 1200 });
    expect(res.statusCode).toBe(202);
    expect(res.data).toEqual({ jobId: expect.any(String), matched: 1200, costUsd: 12 });
    // Nothing is deleted in the request.
    expect(await tally()).toEqual(before);
    const job = await prisma.job.findUniqueOrThrow({ where: { id: res.data.jobId } });
    expect(job).toMatchObject({ type: RUNS_DELETE_JOB, status: 'pending' });
    expect(job.payload).toMatchObject({ userId: user.userId, filter: { taskId: task } });
    // The same request again is the same job, not a second one.
    expect((await call<Queued>(user, 'POST', '/runs/delete', { filter: { taskId: task }, expectedCount: 1200 })).data.jobId).toBe(job.id);

    // A run that finishes after the request is not part of it.
    await new Promise((r) => setTimeout(r, 20));
    const later = await run(user.userId, { taskId: task, status: 'succeeded', goal: 'Created after the request' });

    const handler = app.get(RunsDeleteHandler, { strict: false });
    await handler.process(job as unknown as Job);
    const after = await tally();
    console.log(`1,200-run filter delete: before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
    expect(after).toEqual({ runs: 2, run_steps: 0, questions: 0 });
    expect(await prisma.run.count({ where: { id: { in: ids } } })).toBe(0);
    expect(await exists(later)).toBe(true);
    expect(await exists(live)).toBe(true);
    expect(await exists(theirs)).toBe(true);
    // A retry of the job finds nothing left and is not an error.
    await handler.process(job as unknown as Job);
    expect(await tally()).toEqual(after);
  }, 120_000);

  it('at exactly 500 matches deletes in the request', async () => {
    const user = await login('edge');
    await prisma.run.createMany({ data: Array.from({ length: 500 }, () => ({ userId: user.userId, goal: 'edge', status: 'failed' as const })) });
    const res = await call<Deleted>(user, 'POST', '/runs/delete', { filter: { q: 'edge' } });
    expect(res).toMatchObject({ statusCode: 200, data: { deleted: 500 } });
    expect(await prisma.run.count({ where: { userId: user.userId } })).toBe(0);
  }, 60_000);
});

describe('what a deleted run takes with it', () => {
  it("clears a schedule's lastRunId; the next tick neither throws nor counts a failure", async () => {
    const user = await login('sched');
    const schedules = app.get(SchedulesService, { strict: false });
    const task = await prisma.task.create({ data: { userId: user.userId, name: 'Daily', goal: 'Check' } });
    const failed = await run(user.userId, { taskId: task.id, status: 'failed', trigger: 'schedule' });
    const keep = await run(user.userId, { taskId: task.id, status: 'failed', trigger: 'schedule' });
    const due = new Date(Date.now() - 60_000);
    const mk = (lastRunId: string) => prisma.taskSchedule.create({ data: { userId: user.userId, taskId: task.id, cron: '0 9 * * *', timezone: 'UTC', nextRunAt: due, lastRunId, consecutiveFailures: 1, concurrency: 'queue' } });
    const s = await mk(failed);
    const control = await mk(keep);
    // Only these two schedules take part (a kept database holds earlier runs' schedules).
    await prisma.taskSchedule.updateMany({ where: { id: { notIn: [s.id, control.id] } }, data: { enabled: false } });

    expect((await call(user, 'DELETE', `/runs/${failed}`)).statusCode).toBe(204);
    expect((await prisma.taskSchedule.findUniqueOrThrow({ where: { id: s.id } })).lastRunId).toBeNull();
    expect((await prisma.taskSchedule.findUniqueOrThrow({ where: { id: control.id } })).lastRunId).toBe(keep);

    await expect(schedules.tick(new Date())).resolves.toMatchObject({ started: 2 });
    const [a, b] = await Promise.all([s.id, control.id].map((id) => prisma.taskSchedule.findUniqueOrThrow({ where: { id } })));
    // The deleted run's failure is no longer counted; the kept one's is.
    expect(a!.consecutiveFailures).toBe(1);
    expect(b!.consecutiveFailures).toBe(2);
    expect(a!.lastRunId).not.toBeNull();
    await prisma.taskSchedule.updateMany({ where: { id: { in: [s.id, control.id] } }, data: { enabled: false } });
  });

  it('removes the stored screenshots of its steps; a storage failure does not fail the request', async () => {
    const user = await login('shots');
    const a = await run(user.userId);
    const b = await run(user.userId);
    const liveRun = await run(user.userId, { status: 'running' });
    await prisma.runStep.createMany({
      data: [
        { runId: a, seq: 1, kind: 'action', screenshotKey: `runs/${a}/1.png` },
        { runId: a, seq: 2, kind: 'action', screenshotKey: `runs/${a}/2.png` },
        { runId: a, seq: 3, kind: 'note' },
        { runId: b, seq: 1, kind: 'action', screenshotKey: `runs/${b}/1.png` },
        { runId: liveRun, seq: 1, kind: 'action', screenshotKey: `runs/${liveRun}/1.png` },
      ],
    });
    expect((await call(user, 'DELETE', `/runs/${a}`)).statusCode).toBe(204);
    expect(sorted(store.delete.mock.calls.map((c) => c[0]))).toEqual([`runs/${a}/1.png`, `runs/${a}/2.png`]);

    // Storage is down: the rows are deleted all the same, and a live run's objects are never touched.
    store.delete.mockReset();
    store.delete.mockRejectedValue(new Error('storage unavailable'));
    const res = await call<Deleted>(user, 'POST', '/runs/delete', { ids: [b, liveRun] });
    expect(res).toMatchObject({ statusCode: 200, data: { deleted: 1, skippedLive: [liveRun] } });
    expect(store.delete.mock.calls.map((c) => c[0])).toEqual([`runs/${b}/1.png`]);
    expect(await exists(b)).toBe(false);

    // Without the storage slice there is no port: the delete still works.
    Object.assign(service, { store: undefined });
    const c = await run(user.userId);
    await prisma.runStep.create({ data: { runId: c, seq: 1, kind: 'action', screenshotKey: `runs/${c}/1.png` } });
    expect((await call(user, 'DELETE', `/runs/${c}`)).statusCode).toBe(204);
    Object.assign(service, { store });
  });

  it("lowers the task's spend30d, and never changes a policy's usage", async () => {
    const user = await login('spend');
    const policy = await call<{ id: string }>(user, 'POST', '/agent-policies/builtin:balanced/duplicate', { name: `Mine ${stamp}` });
    expect(policy.statusCode).toBe(201);
    const task = (await call<{ id: string }>(user, 'POST', '/tasks', { name: 'Fares', goal: 'Find a fare', policyId: policy.data.id })).data.id;
    const cheap = await run(user.userId, { taskId: task, modelCalls: 1, costUsd: '0.25', policyRef: policy.data.id });
    const dear = await run(user.userId, { taskId: task, modelCalls: 5, costUsd: '2.5', policyRef: policy.data.id });
    type Task = { spend30d: { runs: number; costUsd: number } };
    type Policy = { usage: { tasks: number; schedules: number } };
    expect((await call<Task>(user, 'GET', `/tasks/${task}`)).data.spend30d).toMatchObject({ runs: 2, costUsd: 2.75 });
    const usage = (await call<Policy>(user, 'GET', `/agent-policies/${policy.data.id}`)).data.usage;
    expect(usage).toEqual({ tasks: 1, schedules: 0 });

    expect((await call<Deleted>(user, 'POST', '/runs/delete', { ids: [dear] })).data).toMatchObject({ deleted: 1, costUsd: 2.5 });
    expect((await call<Task>(user, 'GET', `/tasks/${task}`)).data.spend30d).toMatchObject({ runs: 1, costUsd: 0.25 });
    expect((await call(user, 'DELETE', `/runs/${cheap}`)).statusCode).toBe(204);
    expect((await call<Task>(user, 'GET', `/tasks/${task}`)).data.spend30d).toMatchObject({ runs: 0, costUsd: 0 });
    // A policy's usage counts tasks and schedules, not runs: deleting runs neither blocks nor unblocks its delete.
    expect((await call<Policy>(user, 'GET', `/agent-policies/${policy.data.id}`)).data.usage).toEqual(usage);
    expect(await call(user, 'DELETE', `/agent-policies/${policy.data.id}`)).toMatchObject({ statusCode: 409, code: 'POLICY_IN_USE' });
  });
});

describe('who may delete', () => {
  it("never deletes another user's run: by id, by ids, or by a filter with their task", async () => {
    const alice = await login('alice');
    const bob = await login('bob');
    const task = (await prisma.task.create({ data: { userId: alice.userId, name: 'Hers', goal: 'g' } })).id;
    const hers = [await run(alice.userId, { taskId: task }), await run(alice.userId, { taskId: task, status: 'failed' })];
    const schedule = await prisma.taskSchedule.create({ data: { userId: alice.userId, taskId: task, cron: '0 9 * * *', enabled: false, lastRunId: hers[0]! } });

    // 404, exactly as for an id that does not exist: never 403, never a hint.
    const single = await call(bob, 'DELETE', `/runs/${hers[0]}`);
    const missing = await call(bob, 'DELETE', `/runs/${randomUUID()}`);
    expect(single).toMatchObject({ statusCode: 404, code: 'RUN_NOT_FOUND' });
    expect({ statusCode: missing.statusCode, code: missing.code }).toEqual({ statusCode: single.statusCode, code: single.code });

    expect((await call<Deleted>(bob, 'POST', '/runs/delete', { ids: hers })).data).toEqual({ deleted: 0, costUsd: null, skippedLive: [], notFound: expect.arrayContaining(hers) });
    expect((await call<Deleted>(bob, 'POST', '/runs/delete', { filter: { taskId: task } })).data).toEqual({ deleted: 0, costUsd: null, skippedLive: [], notFound: [] });
    expect((await call<Deleted>(bob, 'POST', '/runs/delete', { filter: {}, expectedCount: 0 })).data.deleted).toBe(0);
    expect(await call(bob, 'POST', '/runs/delete', { filter: { taskId: task }, expectedCount: 2 })).toMatchObject({ statusCode: 409, code: 'COUNT_CHANGED', details: { matched: 0 } });
    // The service too, called for the wrong user (what a job does).
    expect(await service.deleteByIds(bob.userId, hers)).toMatchObject({ deleted: 0, notFound: expect.arrayContaining(hers) });
    expect(await service.deleteMatching(bob.userId, { taskId: task })).toMatchObject({ deleted: 0 });

    for (const id of hers) expect(await exists(id)).toBe(true);
    expect((await prisma.taskSchedule.findUniqueOrThrow({ where: { id: schedule.id } })).lastRunId).toBe(hers[0]);
    // And she still can.
    expect((await call<Deleted>(alice, 'POST', '/runs/delete', { filter: { taskId: task } })).data.deleted).toBe(2);
  });

  it('needs runs:delete: a viewer gets 403 on all three, nobody anonymous', async () => {
    const owner = await login('perm');
    const viewer = await login('perm-viewer', 'viewer');
    const id = await run(viewer.userId);
    expect((await call(viewer, 'GET', `/runs/${id}`)).statusCode).toBe(200);
    expect((await call(viewer, 'DELETE', `/runs/${id}`)).statusCode).toBe(403);
    expect((await call(viewer, 'POST', '/runs/delete', { ids: [id] })).statusCode).toBe(403);
    expect((await call(viewer, 'POST', '/runs/delete', { filter: { status: 'succeeded' } })).statusCode).toBe(403);
    expect(await exists(id)).toBe(true);
    expect((await app.inject({ method: 'DELETE', url: `/api/runs/${id}` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/runs/delete', payload: { ids: [id] } })).statusCode).toBe(401);
    // The permission is its own: declared, and granted to contributors and organization admins.
    const me = await call<{ permissions: string[] }>(owner, 'GET', '/auth/me');
    expect(me.data.permissions).toContain('runs:delete');
    expect((await call<{ permissions: string[] }>(viewer, 'GET', '/auth/me')).data.permissions).not.toContain('runs:delete');
  });

  it('records each call with counts and filter keys, never the goal text', async () => {
    const user = await login('audit');
    const goal = `Find the fare FAKE-GOAL-MARKER-${stamp}`;
    await run(user.userId, { goal, status: 'failed' });
    const single = await run(user.userId, { goal });
    await call(user, 'DELETE', `/runs/${single}`);
    await call(user, 'POST', '/runs/delete', { filter: { q: 'FAKE-GOAL-MARKER', status: 'failed' } });
    const events = await prisma.auditEvent.findMany({ where: { actorUserId: user.userId, action: 'runs.deleted' }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => e.meta)).toEqual([
      { mode: 'single', matched: 1, deleted: 1, skippedLive: 0, jobId: null, filterKeys: null },
      { mode: 'filter', matched: 1, deleted: 1, skippedLive: 0, jobId: null, filterKeys: 'q,status' },
    ]);
    expect(JSON.stringify(events)).not.toContain('FAKE-GOAL-MARKER');
  });
});
