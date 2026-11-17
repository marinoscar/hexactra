// The db tier: the runs list (#420) against a real, migrated and seeded
// database: keyset paging, every filter, the counts, and what a list row carries.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Prisma } from '@prisma/client';

import { createApp } from '../src/main';
import { builtinPolicy } from '../src/policies/builtin-policies';
import { PrismaService } from '../src/prisma/prisma.service';
import { decodeRunCursor, encodeRunCursor } from '../src/tasks/runs.query';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;

async function login(name: string): Promise<{ token: string; userId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `${name}-${stamp}@example.test`, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}

interface Row {
  id: string;
  status: string;
  goal: string;
  createdAt: string;
  [k: string]: unknown;
}
interface Page {
  items: Row[];
  nextCursor: string | null;
}

async function get<T>(token: string, url: string): Promise<T> {
  const res = await app.inject({ method: 'GET', url: `/api${url}`, headers: { authorization: `Bearer ${token}` } });
  if (res.statusCode !== 200) throw new Error(`${url}: ${res.statusCode} ${res.body}`);
  return res.json<{ data: T }>().data;
}
async function status(token: string, url: string): Promise<{ statusCode: number; code?: string }> {
  const res = await app.inject({ method: 'GET', url: `/api${url}`, headers: { authorization: `Bearer ${token}` } });
  const body = res.json<{ code?: string; error?: { code?: string } }>();
  return { statusCode: res.statusCode, code: body.code ?? body.error?.code };
}

/** Every page of a query, following `nextCursor`. */
async function pages(token: string, query: string): Promise<Row[][]> {
  const out: Row[][] = [];
  let cursor: string | null = null;
  do {
    const page: Page = await get<Page>(token, `/runs?envelope=1&${query}${cursor ? `&cursor=${cursor}` : ''}`);
    out.push(page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

const DAY = 86_400_000;
const T0 = Date.parse('2026-06-01T12:00:00.000Z');
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
const sorted = (v: string[]) => [...v].sort();

const snapshot = (ref: string, name: string, padding = 0) => ({
  schemaVersion: 1,
  ref,
  name,
  version: 3,
  builtin: ref.startsWith('builtin:'),
  source: 'task',
  spec: builtinPolicy('builtin:balanced')!.spec,
  padding: 'x'.repeat(padding),
  tiers: null,
  takenAt: new Date(T0).toISOString(),
  effectiveBudget: {
    limits: { actions: 60, modelCalls: null, activeMinutes: 20, inputTokens: null, outputTokens: null, cost: 2 },
    source: { actions: 'policy', modelCalls: null, activeMinutes: 'policy', inputTokens: null, outputTokens: null, cost: 'ceiling' },
    warnAtPercent: 80,
  },
});

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app?.close();
});

describe('GET /runs: keyset paging', () => {
  let user: { token: string; userId: string };
  let expectedDesc: string[];

  beforeAll(async () => {
    user = await login('pager');
    // 250 runs: 200 a minute apart, 30 that share one creation time (the id is the tiebreak),
    // and 20 inside one millisecond, told apart only by the microseconds Postgres stores.
    const data: Prisma.RunCreateManyInput[] = [];
    for (let n = 0; n < 200; n++) data.push({ userId: user.userId, goal: `spread ${n}`, createdAt: new Date(T0 + n * 60_000) });
    for (let n = 0; n < 30; n++) data.push({ userId: user.userId, goal: `same ${n}`, createdAt: new Date(T0 + 50 * 60_000) });
    const micro = Array.from({ length: 20 }, () => randomUUID());
    for (const id of micro) data.push({ id, userId: user.userId, goal: 'micro', createdAt: new Date(T0 + 120 * 60_000) });
    await prisma.run.createMany({ data });
    for (const [n, id] of micro.entries()) await prisma.$executeRaw`UPDATE runs SET created_at = created_at + make_interval(secs => ${((n % 7) * 100 + 1) / 1_000_000}::float8) WHERE id = ${id}::uuid`;
    const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM runs WHERE user_id = ${user.userId}::uuid ORDER BY created_at DESC, id DESC`;
    expectedDesc = ids(rows);
    expect(expectedDesc).toHaveLength(250);
  });

  it.each(['desc', 'asc'] as const)('pages 250 runs as 100, 100, 50 with no duplicate and no gap (%s)', async (order) => {
    const got = await pages(user.token, `limit=100&order=${order}`);
    expect(got.map((p) => p.length)).toEqual([100, 100, 50]);
    expect(ids(got.flat())).toEqual(order === 'desc' ? expectedDesc : [...expectedDesc].reverse());
  });

  it('pages through rows that share a creation time, and rows a microsecond apart, at any page size', async () => {
    for (const limit of [7, 15]) {
      for (const order of ['desc', 'asc'] as const) {
        const got = (await pages(user.token, `limit=${limit}&order=${order}`)).flat();
        expect(ids(got)).toEqual(order === 'desc' ? expectedDesc : [...expectedDesc].reverse());
      }
    }
  });

  it('answers a null cursor on the last page and on an empty result', async () => {
    const all = await get<Page>(user.token, '/runs?envelope=1&limit=100&q=same');
    expect(all.items).toHaveLength(30);
    expect(all.nextCursor).toBeNull();
    expect(await get<Page>(user.token, '/runs?envelope=1&q=no-such-goal')).toEqual({ items: [], nextCursor: null });
    // Exactly one full page: nothing follows it.
    expect((await get<Page>(user.token, '/runs?envelope=1&limit=30&q=same')).nextCursor).toBeNull();
  });

  it('keeps the filter across pages', async () => {
    const got = await pages(user.token, 'limit=12&q=SAME');
    expect(got.map((p) => p.length)).toEqual([12, 12, 6]);
    expect(new Set(ids(got.flat())).size).toBe(30);
  });

  it('without envelope still answers a plain array: the newest `limit`, up to 200', async () => {
    const def = await get<Row[]>(user.token, '/runs');
    expect(Array.isArray(def)).toBe(true);
    expect(ids(def)).toEqual(expectedDesc.slice(0, 50));
    expect(ids(await get<Row[]>(user.token, '/runs?limit=200'))).toEqual(expectedDesc.slice(0, 200));
    expect((await status(user.token, '/runs?limit=201')).statusCode).toBe(400);
    expect((await status(user.token, '/runs?envelope=1&limit=101')).statusCode).toBe(400);
    expect((await status(user.token, '/runs?envelope=1&limit=0')).statusCode).toBe(400);
  });

  it('rejects a cursor it did not issue with INVALID_CURSOR', async () => {
    for (const cursor of ['nonsense', Buffer.from('{"c":"yesterday","i":"1"}').toString('base64url'), Buffer.from('[]').toString('base64url')]) {
      expect(await status(user.token, `/runs?envelope=1&cursor=${cursor}`)).toEqual({ statusCode: 400, code: 'INVALID_CURSOR' });
    }
    const cursor = encodeRunCursor({ c: '2026-06-01T12:00:00.000001Z', i: randomUUID() });
    expect(decodeRunCursor(cursor).c).toBe('2026-06-01T12:00:00.000001Z');
  });

  it("does not let another user's cursor page into these runs", async () => {
    const other = await login('other');
    await prisma.run.createMany({ data: [0, 1, 2].map((n) => ({ userId: other.userId, goal: `theirs ${n}`, createdAt: new Date(T0 + 300 * 60_000 + n) })) });
    const first = await get<Page>(user.token, '/runs?envelope=1&limit=100');
    expect(first.nextCursor).not.toBeNull();
    // The other user replays this user's cursor: only their own rows, older than it (none).
    const replay = await get<Page>(other.token, `/runs?envelope=1&limit=100&cursor=${first.nextCursor!}`);
    expect(replay).toEqual({ items: [], nextCursor: null });
    // And their whole list never holds one of this user's runs.
    const theirs = (await pages(other.token, 'limit=2')).flat();
    expect(theirs.map((r) => r.goal).sort()).toEqual(['theirs 0', 'theirs 1', 'theirs 2']);
    expect(theirs.some((r) => expectedDesc.includes(r.id))).toBe(false);
    expect((await get<{ total: number }>(other.token, '/runs/counts')).total).toBe(3);
    // A task id that is not theirs is simply an empty list.
    const task = await prisma.task.create({ data: { userId: user.userId, name: 'Mine', goal: 'g' } });
    expect(await get<Row[]>(other.token, `/runs?taskId=${task.id}`)).toEqual([]);
  });
});

describe('GET /runs: filters, counts and row shape', () => {
  let user: { token: string; userId: string };
  let taskA: string;
  let taskB: string;
  const id: Record<string, string> = {};
  let ownPolicy: string;

  beforeAll(async () => {
    user = await login('filter');
    taskA = (await prisma.task.create({ data: { userId: user.userId, name: 'Fare check', goal: 'Find a fare' } })).id;
    taskB = (await prisma.task.create({ data: { userId: user.userId, name: 'Inbox sweep', goal: 'Sweep' } })).id;
    ownPolicy = randomUUID();
    const base = { userId: user.userId };
    const rows: Record<string, Omit<Prisma.RunCreateManyInput, 'userId'>> = {
      queued: { status: 'queued', trigger: 'manual', taskId: taskA, goal: 'Find a FARE to Lisbon', createdAt: new Date(T0 + 9 * DAY) },
      running: {
        status: 'running',
        trigger: 'schedule',
        taskId: taskA,
        goal: 'Find a fare to Porto',
        createdAt: new Date(T0 + 8 * DAY),
        startedAt: new Date(T0 + 8 * DAY + 1000),
        policyRef: 'builtin:balanced',
        policyVersion: 3,
        policySource: 'task',
        policySnapshot: snapshot('builtin:balanced', 'Balanced'),
        currentTier: 'standard',
        modelCalls: 4,
        costUsd: '0.25',
        stepCount: 6,
      },
      waiting: { status: 'waiting_human', trigger: 'api', taskId: taskB, goal: 'Sweep the inbox', createdAt: new Date(T0 + 7 * DAY) },
      ok: {
        status: 'succeeded',
        trigger: 'schedule',
        taskId: taskB,
        goal: 'Sweep the inbox again',
        createdAt: new Date(T0 + 6 * DAY),
        startedAt: new Date(T0 + 6 * DAY + 1000),
        finishedAt: new Date(T0 + 6 * DAY + 61_000),
        stopReason: 'finished',
        policyRef: 'builtin:balanced',
        policyVersion: 3,
        policySource: 'task',
        policySnapshot: snapshot('builtin:balanced', 'Balanced'),
        modelCalls: 10,
        costUsd: '1.5',
      },
      failedCost: {
        status: 'failed',
        trigger: 'mcp',
        taskId: null,
        goal: 'Book a table',
        createdAt: new Date(T0 + 5 * DAY),
        finishedAt: new Date(T0 + 5 * DAY + 5000),
        stopReason: 'budget_cost',
        policyRef: ownPolicy,
        policyVersion: 3,
        policySource: 'run',
        policySnapshot: snapshot(ownPolicy, 'Fare lookups'),
        modelCalls: 30,
        costUsd: '2.000001',
        costKnown: false,
      },
      failedActions: { status: 'failed', trigger: 'manual', taskId: taskA, goal: 'find a fare to Faro', createdAt: new Date(T0 + 4 * DAY), stopReason: 'budget_actions', policyRef: 'builtin:economy', modelCalls: 2, costUsd: '0.01' },
      stalled: { status: 'failed', trigger: 'external', taskId: null, goal: 'External session', actor: 'framework-x', createdAt: new Date(T0 + 3 * DAY), stopReason: 'stalled' },
      cancelled: { status: 'cancelled', trigger: 'manual', taskId: taskA, goal: '100% of the fares', createdAt: new Date(T0 + 2 * DAY), stopReason: 'cancelled' },
    };
    for (const [key, row] of Object.entries(rows)) {
      id[key] = randomUUID();
      await prisma.run.create({ data: { ...base, ...row, id: id[key], transcript: [{ role: 'user', content: 'secret-free transcript' }] } as Prisma.RunUncheckedCreateInput });
    }
  });

  const list = async (query: string) => sorted(ids(await get<Row[]>(user.token, `/runs?${query}`)));
  const of = (...keys: string[]) => sorted(keys.map((k) => id[k]!));

  it('filters by a status list, repeated or comma-separated, and by one status', async () => {
    expect(await list('status=failed')).toEqual(of('failedCost', 'failedActions', 'stalled'));
    expect(await list('status=queued,cancelled')).toEqual(of('queued', 'cancelled'));
    expect(await list('status=queued&status=cancelled')).toEqual(of('queued', 'cancelled'));
    expect((await status(user.token, '/runs?status=done')).statusCode).toBe(400);
  });

  it('filters by state', async () => {
    expect(await list('state=live')).toEqual(of('queued', 'running', 'waiting'));
    expect(await list('state=finished')).toEqual(of('ok', 'failedCost', 'failedActions', 'stalled', 'cancelled'));
  });

  it('filters by task, and by no task', async () => {
    expect(await list(`taskId=${taskB}`)).toEqual(of('waiting', 'ok'));
    expect(await list('taskId=none')).toEqual(of('failedCost', 'stalled'));
    expect(await list(`taskId=${randomUUID()}`)).toEqual([]);
    expect((await status(user.token, '/runs?taskId=nope')).statusCode).toBe(400);
  });

  it('filters by trigger', async () => {
    expect(await list('trigger=schedule')).toEqual(of('running', 'ok'));
    expect(await list('trigger=mcp,external')).toEqual(of('failedCost', 'stalled'));
    expect((await status(user.token, '/runs?trigger=cron')).statusCode).toBe(400);
  });

  it('filters by creation time: from inclusive, to exclusive', async () => {
    const at = (days: number) => encodeURIComponent(new Date(T0 + days * DAY).toISOString());
    expect(await list(`from=${at(7)}`)).toEqual(of('queued', 'running', 'waiting'));
    expect(await list(`to=${at(4)}`)).toEqual(of('stalled', 'cancelled'));
    expect(await list(`from=${at(4)}&to=${at(6)}`)).toEqual(of('failedCost', 'failedActions'));
    expect((await status(user.token, '/runs?from=yesterday')).statusCode).toBe(400);
  });

  it('searches the goal, case-insensitively, as text and not as a pattern', async () => {
    expect(await list('q=fare')).toEqual(of('queued', 'running', 'failedActions', 'cancelled'));
    expect(await list('q=%20FARE%20TO%20')).toEqual(of('queued', 'running', 'failedActions'));
    expect(await list(`q=${encodeURIComponent('100%')}`)).toEqual(of('cancelled'));
    expect(await list(`q=${encodeURIComponent("' OR 1=1 --")}`)).toEqual([]);
    // An empty search is no search.
    expect(await list('q=')).toHaveLength(8);
    expect((await status(user.token, `/runs?q=${'x'.repeat(201)}`)).statusCode).toBe(400);
  });

  it('filters by stop reason, with `budget` as every budget_* reason', async () => {
    expect(await list('stopReason=budget')).toEqual(of('failedCost', 'failedActions'));
    expect(await list('stopReason=budget_cost')).toEqual(of('failedCost'));
    expect(await list('stopReason=stalled,budget')).toEqual(of('failedCost', 'failedActions', 'stalled'));
    expect((await status(user.token, '/runs?stopReason=bored')).statusCode).toBe(400);
  });

  it('filters by policy', async () => {
    expect(await list('policyId=builtin:balanced')).toEqual(of('running', 'ok'));
    expect(await list(`policyId=${ownPolicy}`)).toEqual(of('failedCost'));
    expect((await status(user.token, '/runs?policyId=builtin:nope')).statusCode).toBe(400);
  });

  it('combines filters', async () => {
    expect(await list(`status=failed&taskId=${taskA}&q=fare`)).toEqual(of('failedActions'));
    expect(await list('state=finished&trigger=schedule,mcp&stopReason=finished,budget')).toEqual(of('ok', 'failedCost'));
    expect(await list(`state=live&from=${encodeURIComponent(new Date(T0 + 8 * DAY).toISOString())}&q=fare&order=asc`)).toEqual(of('queued', 'running'));
  });

  it('rejects status with state, and from after to, with INVALID_FILTER', async () => {
    const from = encodeURIComponent(new Date(T0 + 5 * DAY).toISOString());
    const to = encodeURIComponent(new Date(T0 + 4 * DAY).toISOString());
    for (const path of ['/runs', '/runs?envelope=1']) {
      const join = path.includes('?') ? '&' : '?';
      expect(await status(user.token, `${path}${join}status=failed&state=live`)).toEqual({ statusCode: 400, code: 'INVALID_FILTER' });
      expect(await status(user.token, `${path}${join}from=${from}&to=${to}`)).toEqual({ statusCode: 400, code: 'INVALID_FILTER' });
    }
    expect(await status(user.token, `/runs/counts?from=${from}&to=${to}`)).toEqual({ statusCode: 400, code: 'INVALID_FILTER' });
  });

  it('gives each row its task name, times, policy and cost, and never the transcript or the policy snapshot', async () => {
    for (const rows of [await get<Row[]>(user.token, '/runs'), (await get<Page>(user.token, '/runs?envelope=1')).items]) {
      expect(rows).toHaveLength(8);
      for (const r of rows) {
        expect(r).not.toHaveProperty('transcript');
        expect(r).not.toHaveProperty('policySnapshot');
        expect(r).not.toHaveProperty('policyRef');
        expect(r).not.toHaveProperty('task');
        for (const k of ['taskName', 'startedAt', 'finishedAt', 'policy', 'budget', 'costUsd', 'costKnown', 'modelCalls', 'stopReason', 'currentTier']) expect(r).toHaveProperty(k);
      }
      const by = (key: string) => rows.find((r) => r.id === id[key])!;
      expect(by('ok')).toMatchObject({
        taskName: 'Inbox sweep',
        startedAt: new Date(T0 + 6 * DAY + 1000).toISOString(),
        finishedAt: new Date(T0 + 6 * DAY + 61_000).toISOString(),
        policy: { id: 'builtin:balanced', name: 'Balanced', version: 3, source: 'task', builtin: true },
        costUsd: 1.5,
        costKnown: true,
        modelCalls: 10,
        stopReason: 'finished',
        // A finished run's budget is on GET /runs/:id.
        budget: null,
      });
      expect(by('failedCost')).toMatchObject({ taskName: null, policy: { id: ownPolicy, name: 'Fare lookups', builtin: false, source: 'task' }, costUsd: 2.000001, costKnown: false, stopReason: 'budget_cost' });
      // A live run keeps its budget.
      expect(by('running')).toMatchObject({ taskName: 'Fare check', currentTier: 'standard', budget: { effective: { actions: 60, cost: 2, warnAtPercent: 80 }, used: { actions: 6, modelCalls: 4, cost: 0.25 }, percent: { actions: 10 } } });
      // No snapshot yet (or a run that never had a policy): no summary.
      expect(by('queued')).toMatchObject({ policy: null, budget: null, startedAt: null, finishedAt: null });
      expect(by('failedActions').policy).toBeNull();
    }
    // The detail route is unchanged: it still reads the snapshot.
    const detail = await get<Row>(user.token, `/runs/${id.ok}`);
    expect(detail).toMatchObject({ policy: { id: 'builtin:balanced' }, budget: { effective: { actions: 60 } } });
    expect(detail).not.toHaveProperty('policySnapshot');
  });

  it('keeps 50 rows with large policy snapshots under 100 KB', async () => {
    const big = await login('big');
    await prisma.run.createMany({
      data: Array.from({ length: 50 }, (_, n) => ({
        userId: big.userId,
        goal: `Find the cheapest fare for trip ${n} and report the price`,
        status: 'succeeded' as const,
        result: 'The cheapest fare is 120 USD.',
        createdAt: new Date(T0 + n * 1000),
        policyRef: 'builtin:balanced',
        policySnapshot: snapshot('builtin:balanced', 'Balanced', 20_000),
        transcript: [{ role: 'user', content: 'y'.repeat(20_000) }],
      })),
    });
    const res = await app.inject({ method: 'GET', url: '/api/runs?envelope=1&limit=50', headers: { authorization: `Bearer ${big.token}` } });
    expect(res.json<{ data: Page }>().data.items).toHaveLength(50);
    const bytes = Buffer.byteLength(res.body);
    console.log(`GET /runs?envelope=1&limit=50: ${bytes} bytes for 50 rows`);
    expect(bytes).toBeLessThan(100_000);
  });

  it('counts per status with the cost, honours the filters, and is not read as a run id', async () => {
    type Counts = { total: number; live: number; byStatus: Record<string, number>; costUsd: number | null; costKnown: boolean };
    const all = await get<Counts>(user.token, '/runs/counts');
    const manual = await prisma.run.groupBy({ by: ['status'], where: { userId: user.userId }, _count: { _all: true } });
    expect(all.byStatus).toEqual({ queued: 0, running: 0, waiting_human: 0, succeeded: 0, failed: 0, cancelled: 0, ...Object.fromEntries(manual.map((g) => [g.status, g._count._all])) });
    expect(all).toMatchObject({ total: 8, live: 3, byStatus: { queued: 1, running: 1, waiting_human: 1, succeeded: 1, failed: 3, cancelled: 1 }, costKnown: false });
    expect(all.costUsd).toBeCloseTo(0.25 + 1.5 + 2.000001 + 0.01, 6);

    expect(await get<Counts>(user.token, `/runs/counts?taskId=${taskB}`)).toEqual({ total: 2, live: 1, byStatus: { queued: 0, running: 0, waiting_human: 1, succeeded: 1, failed: 0, cancelled: 0 }, costUsd: 1.5, costKnown: true });
    expect(await get<Counts>(user.token, '/runs/counts?stopReason=budget&q=FARE')).toMatchObject({ total: 1, live: 0, byStatus: { failed: 1 }, costUsd: 0.01, costKnown: true });
    // No counted run made a model call: there is no cost to show.
    expect(await get<Counts>(user.token, '/runs/counts?trigger=external')).toMatchObject({ total: 1, costUsd: null, costKnown: true });
    expect(await get<Counts>(user.token, '/runs/counts?q=no-such-goal')).toEqual({ total: 0, live: 0, byStatus: { queued: 0, running: 0, waiting_human: 0, succeeded: 0, failed: 0, cancelled: 0 }, costUsd: null, costKnown: true });
    // The counts are per status: a status filter is not part of them.
    expect((await get<Counts>(user.token, '/runs/counts?status=failed&state=live')).total).toBe(8);

    expect((await app.inject({ method: 'GET', url: '/api/runs/counts' })).statusCode).toBe(401);
  });
});
