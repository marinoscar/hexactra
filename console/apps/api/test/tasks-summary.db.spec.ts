// The task list, summaries, schedule sets, pause/resume, the profile time zone
// and the task statistics (#424) against a real, migrated and seeded database.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { UserSettingsService } from '@marinoscar/platform-api/settings';
import { Client } from 'pg';

import { createApp } from '../src/main';
import { balancedSpec } from '../src/policies/builtin-policies';
import { PrismaService } from '../src/prisma/prisma.service';
import { SchedulesService } from '../src/schedules/schedules.service';
import { TaskSummaryService } from '../src/tasks/task-summary.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;
const DAY = 86_400_000;
const HOUR = 3_600_000;

type Res = { statusCode: number; headers: Record<string, unknown>; json: <U>() => U };
type Sched = { id: string; cron: string; timezone: string; enabled: boolean; concurrency: string; nextRunAt: string | null; lastRunAt: string | null; consecutiveFailures: number; description: string; policyId: string | null };
type Summary = {
  schedules: Sched[];
  scheduleState: string;
  nextRunAt: string | null;
  lastRun: { id: string; status: string; trigger: string; createdAt: string; finishedAt: string | null } | null;
  liveRunId: string | null;
  runCounts: { total: number; last7d: { succeeded: number; failed: number; cancelled: number } };
  policy: { id: string; name: string; builtin: boolean; isDefault: boolean } | null;
};
type TaskRow = { id: string; name: string; policyId: string | null; spend30d: { runs: number; costUsd: number; costKnown: boolean; tokens: number; succeeded: number; avgSuccessCostUsd: number | null }; summary: Summary };
type Page = { items: TaskRow[]; nextCursor: string | null; total: number };
type ErrorBody = { statusCode: number; code: string; message: string; details?: { path?: string; issues?: { path: string; message: string }[] } };

async function login(email: string, role: 'contributor' | 'viewer' = 'contributor') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
const as = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const data = <T,>(res: Res): T => res.json<{ data: T }>().data;
const err = (res: Res): ErrorBody => res.json<ErrorBody>();
const get = (token: string, url: string, extra: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers: as(token, extra) }) as unknown as Promise<Res>;
const send = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', token: string, url: string, payload?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: as(token, extra), ...(payload !== undefined ? { payload: payload as object } : {}) }) as unknown as Promise<Res>;

async function createPolicy(token: string, name: string): Promise<{ id: string; name: string }> {
  const res = await send('POST', token, '/api/agent-policies', { name, spec: balancedSpec() });
  expect(res.statusCode).toBe(201);
  return data(res);
}

// No job worker: it would pick up the runs the tick starts and fail them (there is no fabric here).
const workerMode = process.env.JOBS_WORKER_MODE;
beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app?.close();
});

describe('GET /tasks: summaries, search, filters, sorts and paging', () => {
  let alice: { token: string; userId: string };
  let bob: { token: string; userId: string };
  let own: { id: string; name: string };
  const id: Record<'alpha' | 'bravo' | 'charlie' | 'delta' | 'echo', string> = { alpha: '', bravo: '', charlie: '', delta: '', echo: '' };
  const now = Date.now();
  const at = (ms: number) => new Date(now + ms);
  let liveRunId = '';
  let alphaNext = '';

  beforeAll(async () => {
    alice = await login(`sum-alice-${stamp}@example.test`);
    bob = await login(`sum-bob-${stamp}@example.test`);
    own = await createPolicy(alice.token, 'Careful');
    const userId = alice.userId;
    const task = (key: keyof typeof id, name: string, goal: string, created: number, policyRef: string | null = null) =>
      prisma.task.create({ data: { userId, name, goal, policyRef, createdAt: at(created) } }).then((t) => (id[key] = t.id));
    // Oldest first: alpha … echo. "delta lower" is lower-case on purpose (name_asc ignores case).
    await task('alpha', 'Alpha report', 'Read the quarterly FIGURES', -5 * HOUR, own.id);
    await task('bravo', 'Bravo', 'Check the fare', -4 * HOUR);
    await task('charlie', 'Charlie', 'Water the plants', -3 * HOUR);
    await task('delta', 'delta lower', 'Count 100%_done items', -2 * HOUR, '00000000-0000-4000-8000-00000000dead'); // a policy that was deleted
    await task('echo', 'Echo', 'Say it again', -1 * HOUR);

    const schedule = (taskId: string, cron: string, enabled: boolean, nextIn: number | null, extra: { consecutiveFailures?: number; policyRef?: string; createdAt?: Date } = {}) =>
      prisma.taskSchedule.create({ data: { userId, taskId, cron, timezone: 'Europe/Madrid', enabled, nextRunAt: nextIn === null ? null : at(nextIn), ...extra } });
    alphaNext = at(2 * HOUR).toISOString();
    await schedule(id.alpha, '0 9 * * 1-5', true, 5 * HOUR, { createdAt: at(-5 * HOUR), policyRef: 'builtin:economy' });
    await schedule(id.alpha, '*/15 * * * *', true, 2 * HOUR, { createdAt: at(-4 * HOUR) });
    await schedule(id.bravo, '30 9 * * *', true, 3 * HOUR, { createdAt: at(-4 * HOUR) });
    await schedule(id.bravo, '0 8 1 * *', false, null, { createdAt: at(-3 * HOUR) });
    await schedule(id.charlie, '5 4 * 2 *', false, null);
    await schedule(id.echo, '0 */2 * * *', true, 1 * HOUR, { consecutiveFailures: 3 });

    const run = (taskId: string, status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled', ago: number, extra: { costUsd?: number; costKnown?: boolean; trigger?: 'manual' | 'schedule'; inputTokens?: number; outputTokens?: number } = {}) =>
      prisma.run.create({ data: { userId, taskId, goal: 'g', status, createdAt: at(-ago), finishedAt: ['succeeded', 'failed', 'cancelled'].includes(status) ? at(-ago + 60_000) : null, ...extra } });
    await run(id.alpha, 'succeeded', 2 * DAY, { costUsd: 1.25, inputTokens: 1000, outputTokens: 200, trigger: 'schedule' });
    await run(id.alpha, 'failed', 10 * DAY, { costUsd: 0.25, costKnown: false });
    await run(id.alpha, 'cancelled', 40 * DAY, { costUsd: 9 }); // outside every window
    await run(id.alpha, 'queued', 2 * HOUR); // an older live run: the newest one wins
    liveRunId = (await run(id.alpha, 'running', 1 * HOUR)).id;
    await run(id.bravo, 'succeeded', 5 * DAY, { costUsd: 1 });
    await run(id.bravo, 'failed', 1 * DAY, { costUsd: 2 });
    await run(id.delta, 'cancelled', 3 * DAY);
    await run(id.echo, 'succeeded', 2 * DAY + HOUR, { costUsd: 0.2 });

    // Bob has a task and a run of his own: none of it may show up for Alice.
    const other = await prisma.task.create({ data: { userId: bob.userId, name: 'Alpha report (not yours)', goal: 'Read the quarterly FIGURES' } });
    await prisma.run.create({ data: { userId: bob.userId, taskId: other.id, goal: 'g', status: 'failed' } });
  });

  const names = (page: Page) => page.items.map((t) => t.name);
  const list = async (query: string) => data<Page>(await get(alice.token, `/api/tasks?envelope=1${query ? `&${query}` : ''}`));

  it('returns the old array with no parameter, and the same array for an empty parameter', async () => {
    const plain = await get(alice.token, '/api/tasks');
    const rows = data<{ name: string; summary?: unknown; spend30d: unknown }[]>(plain);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.map((t) => t.name)).toEqual(['Echo', 'delta lower', 'Charlie', 'Bravo', 'Alpha report']);
    expect(rows[0]).not.toHaveProperty('summary');
    expect(rows[0]).toHaveProperty('spend30d');
    expect(data<unknown[]>(await get(alice.token, '/api/tasks?q=&filter='))).toHaveLength(5);
    // New parameters without `envelope` still return an array.
    const some = data<TaskRow[]>(await get(alice.token, '/api/tasks?include=summary&limit=2'));
    expect(some.map((t) => t.name)).toEqual(['Echo', 'delta lower']);
    expect(some[0]!.summary.scheduleState).toBe('active');
  });

  it('builds the summary of each task: schedules, state, next run, last run, live run, counts and spend', async () => {
    const page = await list('include=summary');
    expect(page.total).toBe(5);
    expect(page.nextCursor).toBeNull();
    const by = new Map(page.items.map((t) => [t.name, t]));

    const alpha = by.get('Alpha report')!;
    expect(alpha.summary.scheduleState).toBe('active');
    expect(alpha.summary.schedules.map((s) => [s.cron, s.description, s.policyId, s.enabled])).toEqual([
      ['0 9 * * 1-5', 'Monday to Friday at 09:00', 'builtin:economy', true],
      ['*/15 * * * *', 'Every 15 minutes', null, true],
    ]);
    expect(alpha.summary.schedules[0]).toMatchObject({ timezone: 'Europe/Madrid', concurrency: 'skip', consecutiveFailures: 0, lastRunAt: null });
    expect(alpha.summary.nextRunAt).toBe(alphaNext); // the earlier of its two schedules
    expect(alpha.summary.liveRunId).toBe(liveRunId);
    expect(alpha.summary.lastRun).toMatchObject({ id: liveRunId, status: 'running', trigger: 'manual', finishedAt: null });
    expect(alpha.summary.runCounts).toEqual({ total: 5, last7d: { succeeded: 1, failed: 0, cancelled: 0 } });
    // The run of 40 days ago is outside the 30 days; one run could not be priced.
    expect(alpha.spend30d).toEqual({ runs: 4, costUsd: 1.5, costKnown: false, tokens: 1200, succeeded: 1, avgSuccessCostUsd: 1.25 });

    const bravo = by.get('Bravo')!;
    expect(bravo.summary.scheduleState).toBe('partial');
    expect(bravo.summary.nextRunAt).toBe(at(3 * HOUR).toISOString());
    expect(bravo.summary.lastRun).toMatchObject({ status: 'failed' });
    expect(bravo.summary.lastRun!.finishedAt).not.toBeNull();
    expect(bravo.summary.liveRunId).toBeNull();
    expect(bravo.summary.runCounts).toEqual({ total: 2, last7d: { succeeded: 1, failed: 1, cancelled: 0 } });
    expect(bravo.spend30d).toEqual({ runs: 2, costUsd: 3, costKnown: true, tokens: 0, succeeded: 1, avgSuccessCostUsd: 1 });

    const charlie = by.get('Charlie')!;
    expect(charlie.summary).toMatchObject({ scheduleState: 'paused', nextRunAt: null, lastRun: null, liveRunId: null, runCounts: { total: 0, last7d: { succeeded: 0, failed: 0, cancelled: 0 } } });
    expect(charlie.summary.schedules[0]!.description).toBe('Custom schedule (5 4 * 2 *)');
    expect(charlie.spend30d).toEqual({ runs: 0, costUsd: 0, costKnown: true, tokens: 0, succeeded: 0, avgSuccessCostUsd: null });

    const delta = by.get('delta lower')!;
    expect(delta.summary).toMatchObject({ scheduleState: 'none', schedules: [], nextRunAt: null, runCounts: { total: 1, last7d: { succeeded: 0, failed: 0, cancelled: 1 } } });

    expect(by.get('Echo')!.summary.schedules[0]).toMatchObject({ consecutiveFailures: 3, description: 'Every 2 hours' });

    // The same object for one task; without `include` the task has no summary.
    const one = data<TaskRow>(await get(alice.token, `/api/tasks/${id.alpha}?include=summary`));
    expect(one.summary).toEqual(alpha.summary);
    expect(one.spend30d).toEqual(alpha.spend30d);
    // The page's spend (one aggregate) and the plain list's (`spendByTask`) are the same figures.
    const plain = data<TaskRow[]>(await get(alice.token, '/api/tasks'));
    for (const t of page.items) expect(plain.find((p) => p.id === t.id)!.spend30d).toEqual(t.spend30d);
    expect(data<object>(await get(alice.token, `/api/tasks/${id.alpha}`))).not.toHaveProperty('summary');
    // A list never carries a transcript or a policy snapshot.
    expect(JSON.stringify(page)).not.toMatch(/transcript|policySnapshot|policy_snapshot/);
  });

  it("resolves the policy that applies: the task's, the user's default, and the default again for a deleted one", async () => {
    const policyOf = async () => new Map((await list('include=summary')).items.map((t) => [t.name, t.summary.policy]));
    let p = await policyOf();
    expect(p.get('Alpha report')).toEqual({ id: own.id, name: 'Careful', builtin: false, isDefault: false });
    expect(p.get('Bravo')).toEqual({ id: 'builtin:balanced', name: 'Balanced', builtin: true, isDefault: true });
    expect(p.get('delta lower')).toEqual({ id: 'builtin:balanced', name: 'Balanced', builtin: true, isDefault: true }); // its policy was deleted

    const chosen = await createPolicy(alice.token, 'Chosen default');
    expect((await send('PUT', alice.token, '/api/agent-policies/default', { policyId: chosen.id })).statusCode).toBe(200);
    p = await policyOf();
    expect(p.get('Alpha report')).toEqual({ id: own.id, name: 'Careful', builtin: false, isDefault: false });
    expect(p.get('Bravo')).toEqual({ id: chosen.id, name: 'Chosen default', builtin: false, isDefault: true });
    expect(p.get('delta lower')).toEqual({ id: chosen.id, name: 'Chosen default', builtin: false, isDefault: true });

    // A task that names the default policy itself is on the default too.
    expect((await send('PUT', alice.token, '/api/agent-policies/default', { policyId: own.id })).statusCode).toBe(200);
    expect((await policyOf()).get('Alpha report')).toEqual({ id: own.id, name: 'Careful', builtin: false, isDefault: true });
    expect((await send('PUT', alice.token, '/api/agent-policies/default', { policyId: null })).statusCode).toBe(200);
  });

  it('searches the name and the goal, ignoring case, with the text taken literally', async () => {
    expect(names(await list('q=ALPHA'))).toEqual(['Alpha report']); // never Bob's "Alpha report (not yours)"
    expect(names(await list('q=figures'))).toEqual(['Alpha report']);
    expect(names(await list(`q=${encodeURIComponent('100%_done')}`))).toEqual(['delta lower']);
    expect(names(await list(`q=${encodeURIComponent('%')}`))).toEqual(['delta lower']); // not a wildcard
    expect(names(await list(`q=${encodeURIComponent('_')}`))).toEqual(['delta lower']);
    const none = await list('q=zzz-no-such-task');
    expect(none).toEqual({ items: [], nextCursor: null, total: 0 });
    expect((await get(alice.token, `/api/tasks?q=${'x'.repeat(201)}`)).statusCode).toBe(400);
  });

  it('filters by schedule state, failing, never run and policy', async () => {
    expect(names(await list('filter=scheduled'))).toEqual(['Echo', 'Bravo', 'Alpha report']);
    expect(names(await list('filter=paused'))).toEqual(['Charlie']);
    expect(names(await list('filter=unscheduled'))).toEqual(['delta lower']);
    expect(names(await list('filter=failing'))).toEqual(['Echo', 'Bravo']); // three failures in a row; the last run failed
    expect(names(await list('filter=never_run'))).toEqual(['Charlie']);
    expect(names(await list(`policyId=${own.id}`))).toEqual(['Alpha report']);
    expect(names(await list('policyId=default'))).toEqual(['Echo', 'Charlie', 'Bravo']);
    expect(names(await list('policyId=builtin:economy'))).toEqual([]);
    const combined = await list('filter=scheduled&q=FARE&policyId=default');
    expect(names(combined)).toEqual(['Bravo']);
    expect(combined.total).toBe(1);
    expect((await get(alice.token, '/api/tasks?filter=nope')).statusCode).toBe(400);
    expect((await get(alice.token, '/api/tasks?policyId=not-a-ref')).statusCode).toBe(400);
  });

  const ORDER: Record<string, string[]> = {
    created_desc: ['Echo', 'delta lower', 'Charlie', 'Bravo', 'Alpha report'],
    name_asc: ['Alpha report', 'Bravo', 'Charlie', 'delta lower', 'Echo'],
    last_run_desc: ['Alpha report', 'Bravo', 'Echo', 'delta lower', 'Charlie'], // never run: last
    next_run_asc: ['Echo', 'Alpha report', 'Bravo', 'delta lower', 'Charlie'], // no next run: last, newest first
    spend_desc: ['Bravo', 'Alpha report', 'Echo', 'delta lower', 'Charlie'],
  };

  it.each(Object.keys(ORDER))('sorts by %s and pages through it with no duplicate and no gap', async (sort) => {
    expect(names(await list(`sort=${sort}`))).toEqual(ORDER[sort]);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Page = await list(`sort=${sort}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(page.total).toBe(5);
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...names(page));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(ORDER[sort]);
  });

  it('refuses a cursor that is not its own', async () => {
    const first = await list('sort=name_asc&limit=2');
    const wrongSort = await get(alice.token, `/api/tasks?envelope=1&sort=created_desc&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(wrongSort.statusCode).toBe(400);
    expect(err(wrongSort).code).toBe('INVALID_TASK_CURSOR');
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    for (const [sort, bad] of [
      ['created_desc', 'garbage'],
      ['created_desc', b64({ s: 'created_desc', c: 'x', i: 'y' })],
      ['name_asc', b64({ s: 'name_asc', n: 'a' })],
      ['spend_desc', b64({ s: 'spend_desc', o: -1 })],
    ]) {
      const res = await get(alice.token, `/api/tasks?envelope=1&sort=${sort}&cursor=${bad}`);
      expect(res.statusCode).toBe(400);
      expect(err(res).code).toBe('INVALID_TASK_CURSOR');
    }
    expect((await get(alice.token, '/api/tasks?envelope=1&limit=101')).statusCode).toBe(400);
    expect((await get(alice.token, '/api/tasks?envelope=1&limit=0')).statusCode).toBe(400);
  });

  it("keeps another user's tasks out, whatever the cursor", async () => {
    const mine = await list('limit=2');
    const theirs = data<Page>(await get(bob.token, `/api/tasks?envelope=1&include=summary&cursor=${encodeURIComponent(mine.nextCursor!)}`));
    expect(theirs.items.every((t) => t.name === 'Alpha report (not yours)')).toBe(true);
    expect(theirs.total).toBe(1);
    expect((await get(bob.token, `/api/tasks/${id.alpha}?include=summary`)).statusCode).toBe(404);
    expect((await get(bob.token, `/api/tasks?envelope=1&policyId=${own.id}`)).json<{ data: Page }>().data.total).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/tasks?envelope=1' })).statusCode).toBe(401);
  });
});

describe('a page of tasks costs a fixed number of queries', () => {
  it('pages 25 tasks created at the same instant by keyset, and reads a page of 20 in at most 8 queries', async () => {
    const carol = await login(`sum-carol-${stamp}@example.test`);
    const userId = carol.userId;
    const createdAt = new Date(Date.now() - HOUR);
    await prisma.task.createMany({ data: Array.from({ length: 25 }, (_, i) => ({ userId, name: `Same instant ${String(i).padStart(2, '0')}`, goal: 'g', createdAt })) });
    const tasks = await prisma.task.findMany({ where: { userId }, select: { id: true } });
    await prisma.taskSchedule.createMany({ data: tasks.map((t) => ({ userId, taskId: t.id, cron: '0 9 * * *', timezone: 'UTC', nextRunAt: new Date(Date.now() + HOUR) })) });
    await prisma.run.createMany({ data: tasks.flatMap((t) => [{ userId, taskId: t.id, goal: 'g', status: 'succeeded' as const }, { userId, taskId: t.id, goal: 'g', status: 'running' as const }]) });

    for (const sort of ['created_desc', 'name_asc']) {
      const seen: string[] = [];
      const sizes: number[] = [];
      let cursor: string | null = null;
      do {
        const page: Page = data<Page>(await get(carol.token, `/api/tasks?envelope=1&sort=${sort}&limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
        expect(page.total).toBe(25);
        sizes.push(page.items.length);
        seen.push(...page.items.map((t) => t.id));
        cursor = page.nextCursor;
      } while (cursor && sizes.length < 10);
      expect(sizes).toEqual([10, 10, 5]);
      expect(new Set(seen).size).toBe(25);
      expect([...seen].sort()).toEqual(tasks.map((t) => t.id).sort());
    }

    // Count the statements the driver sends for one page, through the service (no sign-in queries).
    const summaries = app.get(TaskSummaryService);
    const count = async (limit: number) => {
      const spy = jest.spyOn(Client.prototype, 'query');
      try {
        const page = await summaries.list(userId, { envelope: '1', include: 'summary', sort: 'created_desc', limit } as never);
        expect(page.items).toHaveLength(limit);
        expect((page.items[0] as { summary: Summary }).summary.runCounts.total).toBe(2);
        return spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
    };
    const twenty = await count(20);
    expect(twenty).toBeGreaterThan(0); // the spy does see the driver
    expect(twenty).toBeLessThanOrEqual(8); // the issue's six, plus one for the policies and one for the connections a task may use (E39.7)
    expect(await count(3)).toBe(twenty); // the same whatever the page size
  });
});

describe('a task with its schedules', () => {
  let dana: { token: string; userId: string };
  let erin: { token: string; userId: string };
  let policy: { id: string; name: string };
  beforeAll(async () => {
    dana = await login(`set-dana-${stamp}@example.test`);
    erin = await login(`set-erin-${stamp}@example.test`);
    policy = await createPolicy(dana.token, 'Dana policy');
  });

  it('creates the task and its schedules together, and nothing at all when one schedule is invalid', async () => {
    // The exact payload shape of the task form (#427): no legacy field, so no Deprecation header.
    const payload = {
      name: 'Morning check',
      goal: 'Open the dashboard and read the numbers',
      profile: 'default',
      hostId: null,
      hostFallback: true,
      policyId: policy.id,
      allowedDomains: ['dash.example.test'],
      confirmRiskyActions: false,
      schedules: [
        { cron: '0 9 * * 1-5', timezone: 'Europe/Madrid', enabled: true, concurrency: 'skip', policyId: 'builtin:economy' },
        { cron: '0 8 1 * *', enabled: false },
      ],
    };
    const created = await send('POST', dana.token, '/api/tasks', payload);
    expect(created.statusCode).toBe(201);
    expect(created.headers).not.toHaveProperty('deprecation');
    const task = data<TaskRow>(created);
    expect(task).toMatchObject({ name: 'Morning check', policyId: policy.id, spend30d: { runs: 0 } });
    expect(task.summary.scheduleState).toBe('partial');
    expect(task.summary.schedules).toHaveLength(2);
    expect(task.summary.schedules[0]).toMatchObject({ cron: '0 9 * * 1-5', timezone: 'Europe/Madrid', enabled: true, policyId: 'builtin:economy', description: 'Monday to Friday at 09:00' });
    expect(new Date(task.summary.schedules[0]!.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    expect(task.summary.schedules[1]).toMatchObject({ cron: '0 8 1 * *', timezone: 'UTC', enabled: false, nextRunAt: null, policyId: null }); // no profile zone, no header: UTC
    expect(task.summary.nextRunAt).toBe(task.summary.schedules[0]!.nextRunAt);
    expect(task.summary.policy).toEqual({ id: policy.id, name: 'Dana policy', builtin: false, isDefault: false });
    expect(await prisma.taskSchedule.count({ where: { taskId: task.id } })).toBe(2);

    // A legacy field still works and is still flagged (E31's behaviour, unchanged).
    const legacy = await send('POST', dana.token, '/api/tasks', { name: 'Legacy', goal: 'g', maxSteps: 12, schedules: [{ cron: '0 9 * * *' }] });
    expect(legacy.statusCode).toBe(201);
    expect(legacy.headers.deprecation).toBe('true');

    const before = { tasks: await prisma.task.count({ where: { userId: dana.userId } }), schedules: await prisma.taskSchedule.count({ where: { userId: dana.userId } }), policies: await prisma.agentPolicy.count({ where: { userId: dana.userId } }) };
    const refused = async (schedules: unknown[], code: string, path: string, extra: Record<string, unknown> = {}) => {
      const res = await send('POST', dana.token, '/api/tasks', { name: 'Never created', goal: 'g', ...extra, schedules });
      expect(res.statusCode).toBe(400);
      expect(err(res)).toMatchObject({ code, details: { path, issues: [{ path }] } });
      expect(err(res).message).toContain(path);
    };
    await refused([{ cron: '0 9 * * *' }, { cron: 'not a cron' }], 'INVALID_CRON', 'schedules[1].cron');
    await refused([{ cron: '0 9 * * *' }, { cron: '* * * * *' }], 'CRON_TOO_FREQUENT', 'schedules[1].cron');
    await refused([{ cron: '0 9 * * *', timezone: 'Mars/Olympus' }], 'INVALID_TIMEZONE', 'schedules[0].timezone');
    await refused([{ cron: '0 9 * * *', policyId: '00000000-0000-4000-8000-000000000404' }], 'POLICY_REF_INVALID', 'schedules[0].policyId');
    const foreign = await createPolicy(erin.token, 'Erin only');
    await refused([{ cron: '0 9 * * *', policyId: foreign.id }], 'POLICY_REF_INVALID', 'schedules[0].policyId');
    // Not even the policy a legacy field would derive is created.
    await refused([{ cron: 'nope' }], 'INVALID_CRON', 'schedules[0].cron', { maxSteps: 7 });
    // More than ten is refused by the body schema.
    expect((await send('POST', dana.token, '/api/tasks', { name: 'Too many', goal: 'g', schedules: Array.from({ length: 11 }, () => ({ cron: '0 9 * * *' })) })).statusCode).toBe(400);
    expect({ tasks: await prisma.task.count({ where: { userId: dana.userId } }), schedules: await prisma.taskSchedule.count({ where: { userId: dana.userId } }), policies: await prisma.agentPolicy.count({ where: { userId: dana.userId } }) }).toEqual(before);

    expect((await send('POST', (await login(`set-viewer-${stamp}@example.test`, 'viewer')).token, '/api/tasks', payload)).statusCode).toBe(403);
  });

  it('replaces the schedule set: updates, creates and deletes in one call, keeping the run history of updated rows', async () => {
    const task = data<TaskRow>(
      await send('POST', dana.token, '/api/tasks', { name: 'Set', goal: 'g', schedules: [{ cron: '0 9 * * *', timezone: 'Europe/Madrid' }, { cron: '0 10 * * *' }, { cron: '0 11 * * *', enabled: false, policyId: policy.id }] }),
    );
    const [keep, drop, off] = task.summary.schedules;
    const lastRunAt = new Date('2026-01-02T03:04:05Z');
    const lastRunId = '00000000-0000-4000-8000-0000000000aa';
    await prisma.taskSchedule.update({ where: { id: keep!.id }, data: { lastRunAt, lastRunId, consecutiveFailures: 2 } });
    await prisma.taskSchedule.update({ where: { id: off!.id }, data: { consecutiveFailures: 4 } });

    const res = await send('PUT', dana.token, `/api/tasks/${task.id}/schedules`, {
      schedules: [
        { id: keep!.id, cron: '30 7 * * 1-5', policyId: 'builtin:thorough' }, // zone left out: unchanged
        { id: off!.id, cron: '0 11 * * *', enabled: true, policyId: null }, // re-enabled, override cleared
        { cron: '0 */2 * * *', timezone: 'America/New_York', concurrency: 'queue' },
      ],
    });
    expect(res.statusCode).toBe(200);
    const after = data<TaskRow>(res).summary.schedules;
    expect(after.map((s) => s.id).sort()).toEqual(expect.arrayContaining([keep!.id, off!.id]));
    expect(after).toHaveLength(3);
    expect(after.map((s) => s.id)).not.toContain(drop!.id);
    const kept = after.find((s) => s.id === keep!.id)!;
    expect(kept).toMatchObject({ cron: '30 7 * * 1-5', timezone: 'Europe/Madrid', enabled: true, consecutiveFailures: 2, lastRunAt: lastRunAt.toISOString(), policyId: 'builtin:thorough', description: 'Monday to Friday at 07:30' });
    expect(kept.nextRunAt).not.toBe(keep!.nextRunAt); // recomputed for the new expression
    expect((await prisma.taskSchedule.findUniqueOrThrow({ where: { id: keep!.id } })).lastRunId).toBe(lastRunId);
    // Going from paused to enabled starts the failure count again.
    expect(after.find((s) => s.id === off!.id)).toMatchObject({ enabled: true, consecutiveFailures: 0, policyId: null });
    expect(after.find((s) => s.id === off!.id)!.nextRunAt).not.toBeNull();
    expect(after.find((s) => s.cron === '0 */2 * * *')).toMatchObject({ timezone: 'America/New_York', concurrency: 'queue', enabled: true, policyId: null });

    // Change the override on an existing schedule, then leave it alone.
    const changed = data<TaskRow>(await send('PUT', dana.token, `/api/tasks/${task.id}/schedules`, { schedules: after.map((s) => ({ id: s.id, cron: s.cron, ...(s.id === keep!.id ? { policyId: policy.id } : {}) })) }));
    expect(changed.summary.schedules.find((s) => s.id === keep!.id)!.policyId).toBe(policy.id);
    expect(changed.summary.schedules.find((s) => s.id === keep!.id)!.consecutiveFailures).toBe(2);

    // Every refusal leaves the set as it was.
    const snapshot = JSON.stringify(await prisma.taskSchedule.findMany({ where: { taskId: task.id }, orderBy: { id: 'asc' } }));
    const refused = async (schedules: unknown[], code: string, path: string) => {
      const r = await send('PUT', dana.token, `/api/tasks/${task.id}/schedules`, { schedules });
      expect(r.statusCode).toBe(400);
      expect(err(r)).toMatchObject({ code, details: { path } });
    };
    await refused([{ cron: '0 9 * * *' }, { id: drop!.id, cron: '0 9 * * *' }], 'SCHEDULE_NOT_IN_TASK', 'schedules[1].id'); // deleted above
    await refused([{ id: keep!.id, cron: '0 9 * * *' }, { id: keep!.id, cron: '0 10 * * *' }], 'SCHEDULE_NOT_IN_TASK', 'schedules[1].id');
    await refused([{ id: keep!.id, cron: '0 9 * * *' }, { cron: 'bad' }], 'INVALID_CRON', 'schedules[1].cron');
    await refused([{ id: keep!.id, cron: '0 9 * * *', policyId: '00000000-0000-4000-8000-000000000404' }], 'POLICY_REF_INVALID', 'schedules[0].policyId');
    const erinTask = data<TaskRow>(await send('POST', erin.token, '/api/tasks', { name: 'Erin', goal: 'g', schedules: [{ cron: '0 9 * * *' }] }));
    await refused([{ id: erinTask.summary.schedules[0]!.id, cron: '0 9 * * *' }], 'SCHEDULE_NOT_IN_TASK', 'schedules[0].id');
    expect(JSON.stringify(await prisma.taskSchedule.findMany({ where: { taskId: task.id }, orderBy: { id: 'asc' } }))).toBe(snapshot);

    // Another user's task: 404, and their schedules are untouched.
    expect((await send('PUT', erin.token, `/api/tasks/${task.id}/schedules`, { schedules: [] })).statusCode).toBe(404);
    expect(await prisma.taskSchedule.count({ where: { taskId: task.id } })).toBe(3);
    // An empty set removes them all.
    expect(data<TaskRow>(await send('PUT', dana.token, `/api/tasks/${task.id}/schedules`, { schedules: [] })).summary).toMatchObject({ schedules: [], scheduleState: 'none' });
  });

  it('holds a task to ten schedules on the single-schedule route too', async () => {
    const task = data<TaskRow>(await send('POST', dana.token, '/api/tasks', { name: 'Full', goal: 'g', schedules: Array.from({ length: 10 }, (_, i) => ({ cron: `0 ${i} * * *` })) }));
    expect(task.summary.schedules.map((s) => s.cron)).toEqual(Array.from({ length: 10 }, (_, i) => `0 ${i} * * *`)); // in the order sent
    const res = await send('POST', dana.token, '/api/schedules', { taskId: task.id, cron: '0 12 * * *' });
    expect(res.statusCode).toBe(409);
    expect(err(res).code).toBe('SCHEDULE_LIMIT');
    expect((await send('PUT', dana.token, `/api/tasks/${task.id}/schedules`, { schedules: Array.from({ length: 11 }, () => ({ cron: '0 9 * * *' })) })).statusCode).toBe(400);
  });

  it('pauses and resumes every schedule of a task; a paused task is not started by the tick', async () => {
    const task = data<TaskRow>(await send('POST', dana.token, '/api/tasks', { name: 'Pausable', goal: 'Check it', schedules: [{ cron: '0 9 * * *' }, { cron: '0 18 * * *', enabled: false }] }));
    await prisma.taskSchedule.updateMany({ where: { taskId: task.id }, data: { consecutiveFailures: 3 } });
    // Only this task's schedules take part in the tick (a kept database holds others).
    await prisma.taskSchedule.updateMany({ where: { taskId: { not: task.id } }, data: { enabled: false } });
    const live = await prisma.run.create({ data: { userId: dana.userId, taskId: task.id, goal: 'g', status: 'running' } });

    const paused = await send('POST', dana.token, `/api/tasks/${task.id}/schedules/pause`);
    expect(paused.statusCode).toBe(200);
    const p = data<TaskRow & { skipped: string[] }>(paused);
    expect(p.skipped).toEqual([]);
    expect(p.summary.scheduleState).toBe('paused');
    expect(p.summary.nextRunAt).toBeNull();
    expect(p.summary.schedules.map((s) => [s.enabled, s.nextRunAt])).toEqual([[false, null], [false, null]]);
    // A live run is left alone.
    expect(p.summary.liveRunId).toBe(live.id);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: live.id } })).status).toBe('running');

    const tick = await app.get(SchedulesService).tick(new Date(Date.now() + 3 * DAY));
    expect(tick.started).toBe(0);
    expect(await prisma.run.count({ where: { taskId: task.id } })).toBe(1);

    const resumed = await send('POST', dana.token, `/api/tasks/${task.id}/schedules/resume`);
    expect(resumed.statusCode).toBe(200);
    const r = data<TaskRow & { skipped: string[] }>(resumed);
    expect(r.skipped).toEqual([]);
    expect(r.summary.scheduleState).toBe('active');
    expect(r.summary.schedules.every((s) => s.enabled && s.consecutiveFailures === 0 && new Date(s.nextRunAt!).getTime() > Date.now())).toBe(true);
    expect(r.summary.nextRunAt).not.toBeNull();

    // A schedule whose stored expression stopped computing is skipped and reported.
    await prisma.taskSchedule.updateMany({ where: { taskId: task.id }, data: { enabled: false, nextRunAt: null } });
    const broken = r.summary.schedules[1]!.id;
    await prisma.taskSchedule.update({ where: { id: broken }, data: { cron: 'broken' } });
    const partly = data<TaskRow & { skipped: string[] }>(await send('POST', dana.token, `/api/tasks/${task.id}/schedules/resume`));
    expect(partly.skipped).toEqual([broken]);
    expect(partly.summary.scheduleState).toBe('partial');

    const bare = data<TaskRow>(await send('POST', dana.token, '/api/tasks', { name: 'No schedule', goal: 'g' }));
    for (const action of ['pause', 'resume']) {
      const none = await send('POST', dana.token, `/api/tasks/${bare.id}/schedules/${action}`);
      expect(none.statusCode).toBe(409);
      expect(err(none).code).toBe('NO_SCHEDULES');
      expect((await send('POST', erin.token, `/api/tasks/${task.id}/schedules/${action}`)).statusCode).toBe(404);
      expect((await send('POST', (await login(`set-viewer2-${stamp}@example.test`, 'viewer')).token, `/api/tasks/${task.id}/schedules/${action}`)).statusCode).toBe(403);
    }
    expect((await prisma.taskSchedule.findMany({ where: { taskId: task.id, enabled: true } })).length).toBe(1); // Erin changed nothing
  });
});

describe('the schedule time zone comes from the profile', () => {
  it('stamps the profile zone, then the device zone, then UTC; an explicit zone wins', async () => {
    const fay = await login(`tz-fay-${stamp}@example.test`);
    const task = data<TaskRow>(await send('POST', fay.token, '/api/tasks', { name: 'Zoned', goal: 'g' }));
    const zoneOf = async (extra: Record<string, string> = {}, body: Record<string, unknown> = {}) => {
      const res = await send('POST', fay.token, '/api/schedules', { taskId: task.id, cron: '0 9 * * *', ...body }, extra);
      expect(res.statusCode).toBe(201);
      return data<Sched>(res).timezone;
    };
    const defaults = async (extra: Record<string, string> = {}) => data<{ timezone: string; source: string }>(await get(fay.token, '/api/schedules/defaults', extra));

    // Nothing in the profile.
    expect(await defaults()).toEqual({ timezone: 'UTC', source: 'default' });
    expect(await zoneOf()).toBe('UTC');
    // The profile follows the device: the zone the client sent.
    expect(await defaults({ 'x-time-zone': 'Asia/Tokyo' })).toEqual({ timezone: 'Asia/Tokyo', source: 'device' });
    expect(await zoneOf({ 'x-time-zone': 'Asia/Tokyo' })).toBe('Asia/Tokyo');
    expect(await defaults({ 'x-time-zone': 'Mars/Olympus' })).toEqual({ timezone: 'UTC', source: 'default' });

    await app.get(UserSettingsService).patchSettings(fay.userId, { profile: { timezone: 'America/Costa_Rica' } } as never);
    expect(await defaults({ 'x-time-zone': 'Asia/Tokyo' })).toEqual({ timezone: 'America/Costa_Rica', source: 'profile' });
    expect(await zoneOf({ 'x-time-zone': 'Asia/Tokyo' })).toBe('America/Costa_Rica');
    expect(await zoneOf({}, { timezone: 'Europe/Madrid' })).toBe('Europe/Madrid');

    // The same rule for schedules sent with a task, for a new item of a set, and for a preview.
    const withTask = data<TaskRow>(await send('POST', fay.token, '/api/tasks', { name: 'Zoned 2', goal: 'g', schedules: [{ cron: '0 9 * * *' }, { cron: '0 10 * * *', timezone: 'Europe/Madrid' }] }));
    expect(withTask.summary.schedules.map((s) => s.timezone)).toEqual(['America/Costa_Rica', 'Europe/Madrid']);
    const set = data<TaskRow>(await send('PUT', fay.token, `/api/tasks/${withTask.id}/schedules`, { schedules: [{ id: withTask.summary.schedules[1]!.id, cron: '0 10 * * *' }, { cron: '0 12 * * *' }] }));
    expect(set.summary.schedules.map((s) => s.timezone)).toEqual(['Europe/Madrid', 'America/Costa_Rica']); // an existing schedule keeps its zone
    const preview = data<{ valid: boolean; timezone: string; next: string[]; description: string }>(await send('POST', fay.token, '/api/schedules/preview', { cron: '0 9 * * *', count: 2 }));
    expect(preview).toMatchObject({ valid: true, timezone: 'America/Costa_Rica', description: 'Every day at 09:00' });
    expect(preview.next).toHaveLength(2);
    expect(preview.next.every((t) => t.endsWith('T15:00:00.000Z'))).toBe(true); // 09:00 in Costa Rica (UTC-6, no daylight saving)

    // A bad zone on the single-schedule route is still a typed 400.
    const bad = await send('POST', fay.token, '/api/schedules', { taskId: task.id, cron: '0 9 * * *', timezone: 'Mars/Olympus' });
    expect(bad.statusCode).toBe(400);
    expect(err(bad).code).toBe('INVALID_TIMEZONE');
  });

  it('previews over HTTP without ever failing on a bad expression, and validates the schedule list filter', async () => {
    const gil = await login(`tz-gil-${stamp}@example.test`);
    const viewer = await login(`tz-viewer-${stamp}@example.test`, 'viewer');
    const preview = async (token: string, body: unknown) => send('POST', token, '/api/schedules/preview', body);
    const ok = await preview(viewer.token, { cron: '0 9 * * 1-5', timezone: 'Europe/Madrid' }); // tasks:read is enough
    expect(ok.statusCode).toBe(200);
    expect(data<{ next: string[] }>(ok).next).toHaveLength(5);
    for (const [body, code] of [
      [{ cron: 'whatever' }, 'INVALID_CRON'],
      [{ cron: '* * * * *' }, 'CRON_TOO_FREQUENT'],
      [{ cron: '0 9 * * *', timezone: 'Mars/Olympus' }, 'INVALID_TIMEZONE'],
    ] as const) {
      const res = await preview(gil.token, body);
      expect(res.statusCode).toBe(200);
      expect(data<{ valid: boolean; code: string; message: string }>(res)).toMatchObject({ valid: false, code });
    }
    expect((await preview(gil.token, { cron: '0 9 * * *', count: 50 })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/schedules/preview', payload: { cron: '0 9 * * *' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/schedules/defaults' })).statusCode).toBe(401);

    const task = data<TaskRow>(await send('POST', gil.token, '/api/tasks', { name: 'Listed', goal: 'g', schedules: [{ cron: '0 9 * * 1,3,5' }] }));
    const rows = data<Sched[]>(await get(gil.token, `/api/schedules?taskId=${task.id}`));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ description: 'Monday, Wednesday and Friday at 09:00', policyId: null });
    expect((await get(gil.token, '/api/schedules?taskId=not-a-uuid')).statusCode).toBe(400);
    expect(data<Sched[]>(await get(viewer.token, `/api/schedules?taskId=${task.id}`))).toEqual([]); // not theirs
  });
});

describe('GET /tasks/:id/stats', () => {
  it('matches hand-computed numbers, fills the empty days, and prices the period', async () => {
    const hal = await login(`stats-hal-${stamp}@example.test`);
    const ivy = await login(`stats-ivy-${stamp}@example.test`);
    const userId = hal.userId;
    const task = data<TaskRow>(await send('POST', hal.token, '/api/tasks', { name: 'Measured', goal: 'g' }));
    const now = Date.now();
    const day = (ago: number) => new Date(now - ago * DAY).toISOString().slice(0, 10);
    const run = (status: 'running' | 'succeeded' | 'failed' | 'cancelled', ago: number, extra: Record<string, unknown> = {}) => {
      const createdAt = new Date(now - ago * DAY);
      return prisma.run.create({ data: { userId, taskId: task.id, goal: 'g', status, createdAt, ...extra } as never });
    };
    const timed = (ago: number, seconds: number) => ({ startedAt: new Date(now - ago * DAY), finishedAt: new Date(now - ago * DAY + seconds * 1000) });
    await run('succeeded', 0, { ...timed(0, 10), stepCount: 4, costUsd: 0.5, stopReason: 'finished' });
    await run('running', 0, { startedAt: new Date(now), stepCount: 50 }); // live: counted in `runs` only
    await run('failed', 1, { ...timed(1, 20), stepCount: 6, costUsd: 0.25, stopReason: 'budget_cost' });
    await run('succeeded', 1, { ...timed(1, 30), stepCount: 2, stopReason: 'finished' }); // no cost
    await run('cancelled', 3, { finishedAt: new Date(now - 3 * DAY), stopReason: 'cancelled' }); // never started
    await run('succeeded', 40, { ...timed(40, 1000), stepCount: 99, costUsd: 7, stopReason: 'finished' }); // only in the 90-day view
    // Another task's and another user's runs never count.
    const otherTask = await prisma.task.create({ data: { userId, name: 'Other', goal: 'g' } });
    await prisma.run.create({ data: { userId, taskId: otherTask.id, goal: 'g', status: 'failed', costUsd: 100 } });

    type Stats = {
      days: number;
      timezone: string;
      totals: { runs: number; succeeded: number; failed: number; cancelled: number; successRate: number | null; costUsd: number | null; costKnown: boolean };
      avgDurationSeconds: number | null;
      p95DurationSeconds: number | null;
      avgSteps: number | null;
      avgCostPerSuccessUsd: number | null;
      series: { date: string; succeeded: number; failed: number; cancelled: number; costUsd: number | null }[];
      stopReasons: { reason: string; count: number }[];
    };
    const res = await get(hal.token, `/api/tasks/${task.id}/stats`);
    expect(res.statusCode).toBe(200);
    const s = data<Stats>(res);
    expect(s.days).toBe(30);
    expect(s.timezone).toBe('UTC');
    expect(s.totals).toEqual({ runs: 5, succeeded: 2, failed: 1, cancelled: 1, successRate: 0.6667, costUsd: 0.75, costKnown: true });
    expect(s.avgDurationSeconds).toBe(20); // (10 + 20 + 30) / 3
    expect(s.p95DurationSeconds).toBe(29); // 20 + 0.9 × (30 − 20)
    expect(s.avgSteps).toBe(3); // (4 + 6 + 2 + 0) / 4 finished runs
    expect(s.avgCostPerSuccessUsd).toBe(0.5); // the one succeeded run that has a cost
    expect(s.series).toHaveLength(30);
    expect(s.series.map((d) => d.date)).toEqual(Array.from({ length: 30 }, (_, i) => day(29 - i)));
    const filled = new Map(s.series.filter((d) => d.succeeded + d.failed + d.cancelled > 0 || d.costUsd !== null).map((d) => [d.date, d]));
    expect([...filled.keys()]).toEqual([day(3), day(1), day(0)]);
    expect(filled.get(day(0))).toEqual({ date: day(0), succeeded: 1, failed: 0, cancelled: 0, costUsd: 0.5 });
    expect(filled.get(day(1))).toEqual({ date: day(1), succeeded: 1, failed: 1, cancelled: 0, costUsd: 0.25 });
    expect(filled.get(day(3))).toEqual({ date: day(3), succeeded: 0, failed: 0, cancelled: 1, costUsd: null });
    expect(s.series[0]).toEqual({ date: day(29), succeeded: 0, failed: 0, cancelled: 0, costUsd: null });
    expect(s.stopReasons).toEqual([{ reason: 'finished', count: 2 }, { reason: 'budget_cost', count: 1 }, { reason: 'cancelled', count: 1 }]);

    // A longer period takes the old run in; a shorter one leaves the same recent days.
    const ninety = data<Stats>(await get(hal.token, `/api/tasks/${task.id}/stats?days=90`));
    expect(ninety.series).toHaveLength(90);
    expect(ninety.totals).toMatchObject({ runs: 6, succeeded: 3, costUsd: 7.75 });
    expect(ninety.avgCostPerSuccessUsd).toBe(3.75);
    expect(data<Stats>(await get(hal.token, `/api/tasks/${task.id}/stats?days=7`)).totals).toEqual(s.totals);

    // One run that could not be priced makes the total a lower bound.
    await prisma.run.updateMany({ where: { taskId: task.id, status: 'failed' }, data: { costKnown: false } });
    expect(data<Stats>(await get(hal.token, `/api/tasks/${task.id}/stats`)).totals).toMatchObject({ costUsd: 0.75, costKnown: false });
    // No run has a cost: null, not zero.
    await prisma.run.updateMany({ where: { taskId: task.id }, data: { costUsd: 0, costKnown: true } });
    const unpriced = data<Stats>(await get(hal.token, `/api/tasks/${task.id}/stats`));
    expect(unpriced.totals).toMatchObject({ costUsd: null, costKnown: true });
    expect(unpriced.avgCostPerSuccessUsd).toBeNull();
    expect(unpriced.series.every((d) => d.costUsd === null)).toBe(true);
    // A run from before stop reasons were recorded.
    await prisma.run.updateMany({ where: { taskId: task.id, status: 'cancelled' }, data: { stopReason: null } });
    expect(data<Stats>(await get(hal.token, `/api/tasks/${task.id}/stats`)).stopReasons).toEqual([{ reason: 'finished', count: 2 }, { reason: 'budget_cost', count: 1 }, { reason: 'unknown', count: 1 }]);

    // No finished run: zeros and nulls.
    const empty = data<TaskRow>(await send('POST', hal.token, '/api/tasks', { name: 'Unmeasured', goal: 'g' }));
    await prisma.run.create({ data: { userId, taskId: empty.id, goal: 'g', status: 'queued' } });
    const e = data<Stats>(await get(hal.token, `/api/tasks/${empty.id}/stats?days=7`));
    expect(e.totals).toEqual({ runs: 1, succeeded: 0, failed: 0, cancelled: 0, successRate: null, costUsd: null, costKnown: true });
    expect(e).toMatchObject({ avgDurationSeconds: null, p95DurationSeconds: null, avgSteps: null, avgCostPerSuccessUsd: null, stopReasons: [] });
    expect(e.series).toHaveLength(7);
    expect(e.series.every((d) => d.succeeded + d.failed + d.cancelled === 0)).toBe(true);
    const none = data<TaskRow>(await send('POST', hal.token, '/api/tasks', { name: 'Never run', goal: 'g' }));
    expect(data<Stats>(await get(hal.token, `/api/tasks/${none.id}/stats`)).totals).toEqual({ runs: 0, succeeded: 0, failed: 0, cancelled: 0, successRate: null, costUsd: null, costKnown: true });

    // The days are the viewer's: the profile zone, else the device zone.
    const far = data<Stats>(await get(hal.token, `/api/tasks/${task.id}/stats?days=7`, { 'x-time-zone': 'Pacific/Kiritimati' })); // UTC+14
    expect(far.timezone).toBe('Pacific/Kiritimati');
    const local = (ms: number) => new Date(ms + 14 * HOUR).toISOString().slice(0, 10);
    expect(far.series[far.series.length - 1]!.date).toBe(local(Date.now()));
    expect(far.series.find((d) => d.date === local(now))).toMatchObject({ succeeded: 1 });

    expect((await get(hal.token, `/api/tasks/${task.id}/stats?days=6`)).statusCode).toBe(400);
    expect((await get(hal.token, `/api/tasks/${task.id}/stats?days=91`)).statusCode).toBe(400);
    expect((await get(ivy.token, `/api/tasks/${task.id}/stats`)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/stats` })).statusCode).toBe(401);
  });
});
