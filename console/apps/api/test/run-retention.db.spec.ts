// The db tier: run retention (#422) against a real, migrated and seeded
// database: the per-user rule (days, newest N per task, failed runs longer),
// the deployment ceiling, the floor (24 h, or an alert rule's window), the
// first-night notice, the preview and "apply now".
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Job } from '@marinoscar/platform-api/jobs';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import type { Prisma } from '@prisma/client';

import { createApp } from '../src/main';
import { RUN_RETENTION_NOTICE_EVENT } from '../src/platform/notifications/hexactra.notifications';
import { PrismaService } from '../src/prisma/prisma.service';
import { RunDeleteService } from '../src/tasks/run-delete.service';
import { RunRetentionDoctorCheck } from '../src/tasks/run-retention.doctor-check';
import { RunRetentionApplyHandler, RunRetentionHandler } from '../src/tasks/run-retention.job';
import { RUNS_RETENTION_APPLY_JOB, RUNS_RETENTION_AUDIT_ACTION, RUNS_RETENTION_JOB, RunRetentionService } from '../src/tasks/run-retention.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
let handler: RunRetentionHandler;
let retention: RunRetentionService;
let notifyNow: jest.SpyInstance;
const stamp = `${Date.now()}`;

// No job worker in this app: the test runs the jobs itself, at a known moment.
const workerMode = process.env.JOBS_WORKER_MODE;
beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp({ docs: true });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
  prisma = app.get(PrismaService);
  handler = app.get(RunRetentionHandler, { strict: false });
  retention = app.get(RunRetentionService, { strict: false });
  notifyNow = jest.spyOn(app.get(NotificationsService, { strict: false }), 'notifyNow');
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => notifyNow.mockClear());

type Session = { token: string; userId: string };
async function login(name: string, role: 'contributor' | 'viewer' | 'admin' = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
async function call<T = unknown>(s: Session, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown): Promise<{ statusCode: number; data: T }> {
  const res = await app.inject({ method, url: `/api${url}`, headers: { authorization: `Bearer ${s.token}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { statusCode: res.statusCode, data: (res.body ? res.json<{ data?: T }>().data : undefined) as T };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);
type RunInput = Omit<Prisma.RunCreateManyInput, 'userId' | 'goal'>;
/** A run that was created and finished `age` ms ago (succeeded unless told otherwise). */
async function run(userId: string, age: number, data: RunInput = {}): Promise<string> {
  const at = ago(age);
  const row = await prisma.run.create({ data: { goal: 'Check the fare', status: 'succeeded', createdAt: at, finishedAt: at, ...data, userId } as Prisma.RunUncheckedCreateInput, select: { id: true } });
  return row.id;
}
async function task(userId: string, name: string): Promise<string> {
  return (await prisma.task.create({ data: { userId, name, goal: 'Check the fare' }, select: { id: true } })).id;
}
const left = async (ids: string[]) => new Set((await prisma.run.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id));
const exists = async (id: string) => (await left([id])).has(id);

interface Rule {
  keepDays?: number | null;
  keepPerTask?: number | null;
  keepFailedDays?: number | null;
}
/** Saves the user's rule the way the settings page does. */
async function save(s: Session, rule: Rule): Promise<void> {
  const res = await call(s, 'PATCH', '/user-settings', { runs: rule });
  expect(res.statusCode).toBe(200);
}
/** One nightly pass, as the job runs it. */
const nightly = () => handler.pass(randomUUID());

interface Preview {
  wouldDelete: number;
  finished: number;
  oldestKept: string | null;
  costUsd: number | null;
  maxKeepDays: number | null;
  capped: boolean;
  floorHours: number;
}
const query = (rule: Rule) =>
  Object.entries(rule)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

describe('the rule', () => {
  it('keepDays: deletes runs finished before the limit, keeps newer ones and every live run', async () => {
    const user = await login('days');
    await save(user, { keepDays: 30 });
    const old = [await run(user.userId, 31 * DAY), await run(user.userId, 200 * DAY, { status: 'failed' }), await run(user.userId, 45 * DAY, { status: 'cancelled' })];
    const young = [await run(user.userId, 29 * DAY), await run(user.userId, 3 * DAY)];
    // Created long ago, finished recently: the age is the finish time.
    const longRun = await run(user.userId, 60 * DAY, { finishedAt: ago(2 * DAY) });
    // Terminal without a finish time: the age falls back to the creation time.
    const noFinish = await run(user.userId, 40 * DAY, { finishedAt: null });
    const live = [
      await run(user.userId, 400 * DAY, { status: 'queued', finishedAt: null }),
      await run(user.userId, 400 * DAY, { status: 'running', finishedAt: null }),
      await run(user.userId, 400 * DAY, { status: 'waiting_human', finishedAt: null }),
    ];
    await prisma.runStep.create({ data: { runId: old[0]!, seq: 1, kind: 'note' } });

    await nightly();

    expect(await left([...old, noFinish])).toEqual(new Set());
    expect(await left([...young, longRun, ...live])).toEqual(new Set([...young, longRun, ...live]));
    expect(await prisma.runStep.count({ where: { runId: old[0]! } })).toBe(0);
    // Idempotent: a second pass the same night deletes nothing more.
    const before = await prisma.run.count({ where: { userId: user.userId } });
    await nightly();
    expect(await prisma.run.count({ where: { userId: user.userId } })).toBe(before);
  });

  it('keepPerTask: exactly the newest 3 remain per task and among the runs without a task', async () => {
    const user = await login('pertask');
    await save(user, { keepDays: null, keepPerTask: 3 });
    const groups: (string | null)[] = [await task(user.userId, 'Fares'), await task(user.userId, 'Prices'), null];
    const byGroup: string[][] = [];
    for (const taskId of groups) {
      const ids: string[] = [];
      // Newest first: 2, 3, … 11 days old.
      for (let n = 0; n < 10; n++) ids.push(await run(user.userId, (n + 2) * DAY, { taskId, status: n % 3 === 0 ? 'failed' : 'succeeded' }));
      byGroup.push(ids);
    }

    await nightly();

    for (const ids of byGroup) expect(await left(ids)).toEqual(new Set(ids.slice(0, 3)));
  });

  it('never deletes a run that finished less than 24 hours ago, or one with a pending question', async () => {
    const user = await login('floor');
    await save(user, { keepDays: 1, keepPerTask: 1 });
    const t = await task(user.userId, 'Fares');
    const newest = await run(user.userId, 1 * HOUR, { taskId: t });
    const twoHours = await run(user.userId, 2 * HOUR, { taskId: t });
    const asked = await run(user.userId, 10 * DAY, { taskId: t });
    await prisma.question.create({ data: { ownerUserId: user.userId, askedBy: `run:${asked}`, runId: asked, prompt: 'Which fare?', status: 'pending', expiresAt: new Date(Date.now() + HOUR) } });
    const gone = await run(user.userId, 26 * HOUR, { taskId: t });

    await nightly();

    expect(await left([newest, twoHours, asked, gone])).toEqual(new Set([newest, twoHours, asked]));
  });

  it('both limits delete the union, and keepFailedDays keeps failures longer', async () => {
    const user = await login('union');
    await save(user, { keepDays: 30, keepPerTask: 2, keepFailedDays: 60 });
    const t = await task(user.userId, 'Fares');
    const kept = [await run(user.userId, 2 * DAY, { taskId: t }), await run(user.userId, 3 * DAY, { taskId: t })];
    const beyondCount = await run(user.userId, 4 * DAY, { taskId: t });
    const other = await task(user.userId, 'Prices');
    const failed45 = await run(user.userId, 45 * DAY, { taskId: other, status: 'failed' });
    const succeeded45 = await run(user.userId, 45 * DAY, { status: 'succeeded' });
    const cancelled45 = await run(user.userId, 45 * DAY, { status: 'cancelled' });
    const failed61 = await run(user.userId, 61 * DAY, { status: 'failed' });

    await nightly();

    expect(await left([...kept, beyondCount, failed45, succeeded45, cancelled45, failed61])).toEqual(new Set([...kept, failed45]));
  });

  it('no limit at all deletes nothing', async () => {
    const user = await login('forever');
    await save(user, { keepDays: null, keepPerTask: null });
    const ids = [await run(user.userId, 3000 * DAY), await run(user.userId, 500 * DAY, { status: 'failed' })];
    await nightly();
    expect(await left(ids)).toEqual(new Set(ids));
  });

  it("one user's rule never touches another user's runs", async () => {
    const a = await login('owner-a');
    const b = await login('owner-b');
    await save(a, { keepDays: 1, keepPerTask: 1 });
    await save(b, { keepDays: null, keepPerTask: null });
    const mine = [await run(a.userId, 5 * DAY), await run(a.userId, 6 * DAY)];
    const theirs = [await run(b.userId, 500 * DAY), await run(b.userId, 600 * DAY), await run(b.userId, 700 * DAY)];

    const seen = await call<Preview>(a, 'GET', '/runs/retention/preview?keepDays=1&keepPerTask=1');
    expect(seen.data).toMatchObject({ wouldDelete: 2, finished: 2 });
    await nightly();

    expect(await left(mine)).toEqual(new Set());
    expect(await left(theirs)).toEqual(new Set(theirs));
  });

  it('salvages a stored namespace field by field', async () => {
    const user = await login('salvage');
    await save(user, { keepDays: 10 });
    const row = await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.userId } });
    await prisma.userSettings.update({ where: { userId: user.userId }, data: { value: { ...(row.value as object), runs: { keepDays: 'soon', keepPerTask: 5, keepFailedDays: -1, noticeSentAt: 'yesterday' } } } });
    expect(await retention.userRetention(user.userId)).toEqual({ limits: { keepDays: 90, keepPerTask: 5, keepFailedDays: null }, noticeSentAt: null });
  });
});

describe('trace screenshots (#541)', () => {
  it('the nightly rule removes the stored pictures of the runs it deletes; a storage failure still deletes the run', async () => {
    const service = app.get(RunDeleteService, { strict: false }) as unknown as { store?: unknown };
    const before = service.store;
    const store = { delete: jest.fn(async (_key: string) => undefined), put: jest.fn(), get: jest.fn() };
    service.store = store;
    try {
      const user = await login('trace-shots');
      await save(user, { keepDays: 30 });
      const old = await run(user.userId, 40 * DAY);
      const failing = await run(user.userId, 41 * DAY);
      const young = await run(user.userId, 2 * DAY);
      await prisma.runStep.createMany({
        data: [
          { runId: old, seq: 1, kind: 'end', screenshotKey: `runs/${user.userId}/${old}/1-final.jpg`, screenshotMoment: 'final' },
          { runId: failing, seq: 1, kind: 'end', screenshotKey: `runs/${user.userId}/${failing}/1-final.jpg`, screenshotMoment: 'final' },
          { runId: young, seq: 1, kind: 'end', screenshotKey: `runs/${user.userId}/${young}/1-final.jpg`, screenshotMoment: 'final' },
        ],
      });
      store.delete.mockImplementation(async (key: string) => {
        if (key.includes(failing)) throw new Error('storage unavailable');
      });
      await nightly();
      expect(store.delete.mock.calls.map((c) => c[0]).sort()).toEqual([`runs/${user.userId}/${failing}/1-final.jpg`, `runs/${user.userId}/${old}/1-final.jpg`].sort());
      expect(await left([old, failing, young])).toEqual(new Set([young]));
    } finally {
      service.store = before;
    }
  });
});

describe('the deployment ceiling', () => {
  let admin: Session;
  const ceiling = async (maxKeepDays: number | null) => {
    const res = await call(admin, 'PATCH', '/system-settings', { runs: { maxKeepDays } });
    expect(res.statusCode).toBe(200);
  };
  beforeAll(async () => {
    admin = await login('ceiling-admin', 'admin');
  });
  afterEach(() => ceiling(null));

  it("cuts a user's \"forever\" and a longer limit down to it, at job time", async () => {
    const forever = await login('ceiling-forever');
    const longer = await login('ceiling-longer');
    const shorter = await login('ceiling-shorter');
    await save(forever, { keepDays: null });
    await save(longer, { keepDays: 365, keepFailedDays: 700 });
    await save(shorter, { keepDays: 10 });
    const f = [await run(forever.userId, 50 * DAY), await run(forever.userId, 40 * DAY)];
    const l = [await run(longer.userId, 50 * DAY), await run(longer.userId, 50 * DAY, { status: 'failed' }), await run(longer.userId, 40 * DAY)];
    const s = [await run(shorter.userId, 11 * DAY), await run(shorter.userId, 9 * DAY)];
    await ceiling(45);

    expect((await call<Preview>(forever, 'GET', '/runs/retention/preview')).data).toMatchObject({ wouldDelete: 1, maxKeepDays: 45, capped: true });
    expect((await call<Preview>(shorter, 'GET', '/runs/retention/preview?keepDays=10')).data).toMatchObject({ wouldDelete: 1, maxKeepDays: 45, capped: false });
    expect((await call<{ keepDays: number | null; maxKeepDays: number | null }>(forever, 'GET', '/runs/retention')).data).toMatchObject({ keepDays: null, maxKeepDays: 45 });
    await nightly();

    expect(await left(f)).toEqual(new Set([f[1]]));
    expect(await left(l)).toEqual(new Set([l[2]]));
    expect(await left(s)).toEqual(new Set([s[1]]));
    // The user's own setting is not rewritten.
    expect((await retention.userRetention(forever.userId)).limits.keepDays).toBeNull();
  });

  it('is a system setting only an administrator may change, and refuses a bad value', async () => {
    const user = await login('ceiling-user');
    expect((await call(user, 'PATCH', '/system-settings', { runs: { maxKeepDays: 5 } })).statusCode).toBe(403);
    expect((await call(admin, 'PATCH', '/system-settings', { runs: { maxKeepDays: 0 } })).statusCode).toBe(400);
    expect((await call<{ runs: { maxKeepDays: number | null } }>(admin, 'GET', '/system-settings')).data.runs).toEqual({ maxKeepDays: null });
  });
});

describe('the floor follows the alert rules', () => {
  const rule = (data: Prisma.AlertRuleUpdateInput) => prisma.alertRule.update({ where: { key: 'hexactra.run_stalled' }, data });
  afterAll(() => rule({ enabled: true, config: { windowHours: 24, minStalls: 3 } }));

  it('keeps a 48-hour-old run while an enabled rule reads 72 hours of runs, and deletes it once the rule is off', async () => {
    const user = await login('alerts');
    await save(user, { keepDays: null, keepPerTask: 1 });
    const t = await task(user.userId, 'Fares');
    const newest = await run(user.userId, 30 * HOUR, { taskId: t });
    const twoDays = await run(user.userId, 48 * HOUR, { taskId: t });
    const fourDays = await run(user.userId, 96 * HOUR, { taskId: t });

    await rule({ enabled: true, config: { windowHours: 72, minStalls: 3 } });
    expect(await retention.floorHours()).toBe(72);
    expect((await call<Preview>(user, 'GET', '/runs/retention/preview?keepPerTask=1')).data).toMatchObject({ wouldDelete: 1, floorHours: 72 });
    await nightly();
    expect(await left([newest, twoDays, fourDays])).toEqual(new Set([newest, twoDays]));

    await rule({ enabled: false });
    expect(await retention.floorHours()).toBe(24);
    await nightly();
    expect(await left([newest, twoDays])).toEqual(new Set([newest]));
  });
});

describe('the preview', () => {
  it('counts exactly what the job then deletes, with their spend and the oldest run kept', async () => {
    const user = await login('preview');
    const rule = { keepDays: 20, keepPerTask: 4, keepFailedDays: 40 };
    await save(user, rule);
    const t = await task(user.userId, 'Fares');
    for (let n = 0; n < 12; n++) await run(user.userId, (n * 5 + 2) * DAY, { taskId: n % 2 ? t : null, status: n % 4 === 0 ? 'failed' : 'succeeded', costUsd: 0.25, modelCalls: 2 });
    await run(user.userId, 300 * DAY, { status: 'running', finishedAt: null });
    await run(user.userId, 2 * HOUR);
    const finished = await prisma.run.count({ where: { userId: user.userId, status: { in: ['succeeded', 'failed', 'cancelled'] } } });

    const seen = (await call<Preview>(user, 'GET', `/runs/retention/preview?${query(rule)}`)).data;
    expect(seen.finished).toBe(finished);
    expect(seen.wouldDelete).toBeGreaterThan(0);
    expect(seen.wouldDelete).toBeLessThan(finished);
    expect(seen.costUsd).toBeCloseTo(seen.wouldDelete * 0.25, 6);

    await nightly();
    const after = await prisma.run.count({ where: { userId: user.userId, status: { in: ['succeeded', 'failed', 'cancelled'] } } });
    expect(finished - after).toBe(seen.wouldDelete);
    const oldest = await prisma.run.findFirstOrThrow({ where: { userId: user.userId, status: { in: ['succeeded', 'failed', 'cancelled'] } }, orderBy: { finishedAt: 'asc' }, select: { finishedAt: true } });
    expect(seen.oldestKept).toBe(oldest.finishedAt!.toISOString());
    // Nothing is left for the same rule.
    expect((await call<Preview>(user, 'GET', `/runs/retention/preview?${query(rule)}`)).data).toMatchObject({ wouldDelete: 0, costUsd: null });
  });

  it('validates the limits and needs runs:delete', async () => {
    const user = await login('preview-bad');
    expect((await call(user, 'GET', '/runs/retention/preview?keepDays=0')).statusCode).toBe(400);
    expect((await call(user, 'GET', '/runs/retention/preview?keepPerTask=1.5')).statusCode).toBe(400);
    // Every limit may be left out or sent empty (no limit), and the OpenAPI document says so.
    expect((await call<Preview>(user, 'GET', '/runs/retention/preview')).data).toMatchObject({ wouldDelete: 0 });
    expect((await call<Preview>(user, 'GET', '/runs/retention/preview?keepDays=&keepPerTask=null')).data).toMatchObject({ wouldDelete: 0 });
    const doc = (await app.inject({ method: 'GET', url: '/api/openapi.json' })).json<{ paths: Record<string, { get: { parameters: { name: string; required: boolean }[] } }> }>();
    expect(doc.paths['/api/runs/retention/preview']!.get.parameters.map((p) => [p.name, p.required])).toEqual([
      ['keepDays', false],
      ['keepPerTask', false],
      ['keepFailedDays', false],
    ]);
    expect((await call(user, 'GET', '/runs/retention/preview?keepDays=')).statusCode).toBe(200);
    const viewer = await login('preview-viewer', 'viewer');
    expect((await call(viewer, 'GET', '/runs/retention/preview')).statusCode).toBe(403);
    expect((await call(viewer, 'GET', '/runs/retention')).statusCode).toBe(403);
    expect((await call(viewer, 'POST', '/runs/retention/apply')).statusCode).toBe(403);
  });
});

describe('a user who never chose a rule', () => {
  it('is told on the first night and loses nothing; the second night deletes', async () => {
    const user = await login('default');
    const old = [await run(user.userId, 91 * DAY), await run(user.userId, 400 * DAY, { status: 'failed' })];
    const young = await run(user.userId, 89 * DAY);
    expect((await call(user, 'GET', '/runs/retention')).data).toMatchObject({ keepDays: 90, keepPerTask: null, keepFailedDays: null, saved: false });

    await nightly();
    expect(await left([...old, young])).toEqual(new Set([...old, young]));
    const notices = () => notifyNow.mock.calls.filter(([event, userId]) => event === RUN_RETENTION_NOTICE_EVENT && userId === user.userId);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]![2]).toMatchObject({ days: 90, count: 2, settingsUrl: expect.stringMatching(/\/settings\/run-history$/) });
    expect((await retention.userRetention(user.userId)).noticeSentAt).not.toBeNull();
    // The limits were not frozen into the user's settings by the notice.
    expect((await call(user, 'GET', '/runs/retention')).data).toMatchObject({ keepDays: 90, saved: true });

    await nightly();
    expect(await left([...old, young])).toEqual(new Set([young]));
    expect(notices()).toHaveLength(1);
  });

  it('gets no notice while nothing is old enough, and none after saving a rule', async () => {
    const quiet = await login('default-quiet');
    await run(quiet.userId, 10 * DAY);
    const chose = await login('default-chose');
    await save(chose, { keepDays: 5 });
    const gone = await run(chose.userId, 10 * DAY);

    await nightly();

    expect(notifyNow.mock.calls.filter(([event, userId]) => event === RUN_RETENTION_NOTICE_EVENT && [quiet.userId, chose.userId].includes(userId as string))).toEqual([]);
    expect((await retention.userRetention(quiet.userId)).noticeSentAt).toBeNull();
    expect(await exists(gone)).toBe(false);
  });
});

describe('the jobs', () => {
  it('POST /runs/retention/apply enqueues one job for the caller, which applies their saved rule to their runs only', async () => {
    const user = await login('apply');
    const bystander = await login('apply-bystander');
    await save(user, { keepDays: 7 });
    await save(bystander, { keepDays: 7 });
    const mine = [await run(user.userId, 8 * DAY), await run(user.userId, 6 * DAY)];
    const theirs = await run(bystander.userId, 8 * DAY);

    const res = await call<{ jobId: string }>(user, 'POST', '/runs/retention/apply');
    expect(res.statusCode).toBe(202);
    const job = await prisma.job.findUniqueOrThrow({ where: { id: res.data.jobId } });
    expect(job).toMatchObject({ type: RUNS_RETENTION_APPLY_JOB, status: 'pending', reason: 'runs_retention_apply', payload: { userId: user.userId } });
    // Sent again while it is pending: the same job.
    expect((await call<{ jobId: string }>(user, 'POST', '/runs/retention/apply')).data.jobId).toBe(job.id);

    await app.get(RunRetentionApplyHandler, { strict: false }).process(job as unknown as Job);
    expect(await left([...mine, theirs])).toEqual(new Set([mine[1], theirs]));
    await prisma.job.update({ where: { id: job.id }, data: { status: 'succeeded', finishedAt: new Date() } });
  });

  it('records the totals of a pass, moves on when one user fails, and the Doctor reports the last success', async () => {
    const ok = await login('pass-ok');
    const broken = await login('pass-broken');
    await save(ok, { keepDays: 3 });
    await save(broken, { keepDays: 3 });
    const gone = await run(ok.userId, 4 * DAY);
    const stuck = await run(broken.userId, 4 * DAY);
    const apply = retention.apply.bind(retention);
    const spy = jest.spyOn(retention, 'apply').mockImplementation((userId, ...rest) => (userId === broken.userId ? Promise.reject(new Error('boom')) : apply(userId, ...rest)));
    const job = await prisma.job.create({ data: { type: RUNS_RETENTION_JOB, reason: 'backfill', status: 'running' } });
    try {
      const totals = await handler.pass(job.id);
      expect(totals.failed).toBe(1);
      expect(totals.deleted).toBeGreaterThanOrEqual(1);
      expect(totals.users).toBeGreaterThanOrEqual(2);
      expect(await exists(gone)).toBe(false);
      expect(await exists(stuck)).toBe(true);
      const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: RUNS_RETENTION_AUDIT_ACTION, targetId: job.id } });
      expect(audit.meta).toMatchObject({ users: totals.users, deleted: totals.deleted, failed: 1 });
    } finally {
      spy.mockRestore();
    }

    const doctor = app.get(RunRetentionDoctorCheck, { strict: false });
    await prisma.job.update({ where: { id: job.id }, data: { status: 'succeeded', finishedAt: new Date() } });
    const fresh = await doctor.run();
    expect(fresh.status).toBe('pass');
    expect(fresh.detail).toMatch(/deleting \d+ run/);
    // Not succeeded for more than 48 hours: a warning.
    await prisma.job.updateMany({ where: { type: RUNS_RETENTION_JOB, status: 'succeeded' }, data: { finishedAt: ago(49 * HOUR) } });
    expect(await doctor.run()).toMatchObject({ status: 'warn', detail: expect.stringMatching(/has not succeeded in 49 hours/) });
  });

  it('fails the job when more than half the users failed', async () => {
    const spy = jest.spyOn(handler, 'pass').mockResolvedValue({ users: 4, deleted: 0, skipped: 1, noticed: 0, failed: 3 });
    await expect(handler.process({ id: randomUUID() } as Job)).rejects.toThrow(/failed for 3 of 4/);
    spy.mockResolvedValue({ users: 4, deleted: 0, skipped: 2, noticed: 0, failed: 2 });
    await expect(handler.process({ id: randomUUID() } as Job)).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
