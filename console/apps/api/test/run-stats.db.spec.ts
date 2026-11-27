// The db tier for run statistics (E53.1, #1069): against a real, migrated database, the statistics count exactly the runs the list
// shows for the same filter, never another user's, carry no goal text, and stay fast for one user with 50,000 runs.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Prisma } from '@prisma/client';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { RunStatsService } from '../src/run-insights/run-stats.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;
const T0 = Date.parse('2026-06-01T12:00:00.000Z');
const DAY = 86_400_000;
const SECRET_GOAL = `Pay invoice for account 4111 1111 1111 1111 ${stamp}`;

async function login(name: string): Promise<{ token: string; userId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `${name}-${stamp}@example.test`, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}

async function call(token: string | null, url: string) {
  return app.inject({ method: 'GET', url: `/api${url}`, headers: token ? { authorization: `Bearer ${token}` } : {} });
}
async function get<T>(token: string, url: string): Promise<T> {
  const res = await call(token, url);
  if (res.statusCode !== 200) throw new Error(`${url}: ${res.statusCode} ${res.body}`);
  return res.json<{ data: T }>().data;
}

interface Dist {
  n: number;
  sum: number;
  p50: number;
  p90: number;
  max: number;
}
interface Group {
  key?: string;
  label?: string;
  runs: number;
  finished: number;
  live: number;
  byStatus: Record<string, number>;
  successRate: number | null;
  costPerSuccessUsd: number | null;
  costKnown: boolean;
  metrics: Record<string, Dist | null>;
}
interface Stats {
  groupBy: string;
  timeZone: string;
  scanned: number;
  truncated: boolean;
  total: Group;
  groups: (Group & { key: string; label: string })[];
  groupsTruncated: boolean;
}

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app?.close();
});

describe('GET /runs/stats', () => {
  let alice: { token: string; userId: string };
  let bob: { token: string; userId: string };
  let taskA: string;
  let taskB: string;
  let policyId: string;

  beforeAll(async () => {
    alice = await login('stats-alice');
    bob = await login('stats-bob');
    taskA = (await prisma.task.create({ data: { userId: alice.userId, name: 'Check fares', goal: 'Check fares' } })).id;
    taskB = (await prisma.task.create({ data: { userId: alice.userId, name: 'Pay invoice', goal: SECRET_GOAL } })).id;
    policyId = (await prisma.agentPolicy.create({ data: { userId: alice.userId, name: `Frugal ${stamp}`, spec: {} } })).id;
    const data: Prisma.RunCreateManyInput[] = [];
    // Task A: 10 finished runs, steps 1..10, 8 succeeded and 2 failed, a day apart, on the balanced policy.
    for (let i = 0; i < 10; i++) {
      const createdAt = new Date(T0 + i * DAY);
      data.push({
        userId: alice.userId,
        taskId: taskA,
        goal: 'Check fares',
        status: i % 5 === 4 ? 'failed' : 'succeeded',
        stopReason: i % 5 === 4 ? 'stalled' : 'finished',
        stepCount: i + 1,
        modelCalls: 2 * (i + 1),
        inputTokens: 1000 * (i + 1),
        cachedInputTokens: 100 * (i + 1),
        outputTokens: 50 * (i + 1),
        activeMs: 60_000 * (i + 1),
        costUsd: 0.01 * (i + 1),
        policyRef: 'builtin:balanced',
        currentTier: 'standard',
        createdAt,
        startedAt: new Date(createdAt.getTime() + 1_000),
        finishedAt: new Date(createdAt.getTime() + 1_000 + 120_000),
      });
    }
    // Task B: 4 runs on the user's own policy, one over budget, one cost unknown, one still running.
    for (let i = 0; i < 4; i++) {
      data.push({
        userId: alice.userId,
        taskId: taskB,
        goal: SECRET_GOAL,
        status: i === 3 ? 'running' : i === 2 ? 'cancelled' : 'succeeded',
        stopReason: i === 2 ? 'budget_cost' : i === 3 ? null : 'finished',
        stepCount: 20,
        modelCalls: 30,
        inputTokens: 5000,
        outputTokens: 500,
        costUsd: 0.5,
        costKnown: i !== 1,
        policyRef: policyId,
        trigger: 'schedule',
        origin: 'schedule',
        createdAt: new Date(T0 + 2 * DAY + i * 3_600_000),
      });
    }
    // No task: an ad-hoc run and a benchmark trial (left out unless named).
    data.push({ userId: alice.userId, goal: 'one-off 50% off_deal', status: 'failed', stopReason: 'error', createdAt: new Date(T0 + 3 * DAY) });
    data.push({ userId: alice.userId, goal: 'trial', status: 'succeeded', trigger: 'benchmark', createdAt: new Date(T0 + 3 * DAY) });
    // Bob's runs never appear in Alice's numbers.
    for (let i = 0; i < 5; i++) data.push({ userId: bob.userId, goal: 'bob', status: 'succeeded', stepCount: 999, costUsd: 9, createdAt: new Date(T0 + i * DAY) });
    await prisma.run.createMany({ data });
  });

  it('answers the total over the caller own runs, benchmark trials left out', async () => {
    const s = await get<Stats>(alice.token, '/runs/stats');
    expect(s.groupBy).toBe('none');
    expect(s.groups).toEqual([]);
    expect(s.total.runs).toBe(15);
    expect(s.total.live).toBe(1);
    expect(s.total.finished).toBe(14);
    expect(s.total.byStatus).toMatchObject({ succeeded: 10, failed: 3, cancelled: 1, running: 1 });
    expect(s.total.successRate).toBe(round3(10 / 14));
    expect(s.total.costKnown).toBe(false);
    expect(s.total.metrics.steps?.max).toBe(20);
    expect(s.truncated).toBe(false);
  });

  it('matches hand-computed percentiles for one task', async () => {
    const s = await get<Stats>(alice.token, `/runs/stats?taskId=${taskA}`);
    expect(s.total.runs).toBe(10);
    expect(s.total.successRate).toBe(0.8);
    // steps 1..10: median 5.5, p90 by nearest rank = 9th value = 9.
    expect(s.total.metrics.steps).toMatchObject({ n: 10, sum: 55, p50: 5.5, p90: 9, max: 10 });
    expect(s.total.metrics.totalTokens).toMatchObject({ n: 10, sum: 57_750, p50: 5_775, p90: 9_450, max: 10_500 });
    expect(s.total.metrics.costUsd).toMatchObject({ n: 10, sum: 0.55, p50: 0.055, p90: 0.09, max: 0.1 });
    expect(s.total.metrics.wallMs).toMatchObject({ n: 10, p50: 120_000 });
    expect(s.total.costPerSuccessUsd).toBe(0.06875);
  });

  it.each([
    '',
    'status=failed,cancelled',
    'state=finished',
    `taskId=${'none'}`,
    'trigger=benchmark',
    'trigger=schedule',
    'stopReason=budget',
    'origin=schedule',
    'q=fares',
    'q=%25',
    'q=_',
    'q=50%25 off_',
    `from=${new Date(T0 + 2 * DAY).toISOString()}&to=${new Date(T0 + 5 * DAY).toISOString()}`,
    'policyId=builtin:balanced',
  ])('counts exactly the runs the list shows for the same filter (%s)', async (filter) => {
    const list = await get<{ id: string }[]>(alice.token, `/runs?limit=200${filter ? `&${filter}` : ''}`);
    const s = await get<Stats>(alice.token, `/runs/stats${filter ? `?${filter}` : ''}`);
    expect(s.total.runs).toBe(list.length);
  });

  it('groups by task with names, largest first, and the groups add up to the total', async () => {
    const s = await get<Stats>(alice.token, '/runs/stats?groupBy=task');
    expect(s.groups.map((g) => [g.key, g.label, g.runs])).toEqual([
      [taskA, 'Check fares', 10],
      [taskB, 'Pay invoice', 4],
      ['none', 'No task', 1],
    ]);
    expect(s.groups.reduce((n, g) => n + g.runs, 0)).toBe(s.total.runs);
  });

  it('labels built-in and own policies', async () => {
    const s = await get<Stats>(alice.token, '/runs/stats?groupBy=policy');
    const labels = Object.fromEntries(s.groups.map((g) => [g.key, g.label]));
    expect(labels).toEqual({ 'builtin:balanced': 'Balanced', [policyId]: `Frugal ${stamp}`, none: 'No policy yet' });
  });

  it('groups by stop reason, status, trigger, origin and tier', async () => {
    const byStop = await get<Stats>(alice.token, '/runs/stats?groupBy=stopReason');
    expect(Object.fromEntries(byStop.groups.map((g) => [g.key, g.runs]))).toEqual({ finished: 10, stalled: 2, budget_cost: 1, error: 1, none: 1 });
    for (const by of ['status', 'trigger', 'origin', 'tier']) {
      const s = await get<Stats>(alice.token, `/runs/stats?groupBy=${by}`);
      expect(s.groups.reduce((n, g) => n + g.runs, 0)).toBe(15);
    }
  });

  it('buckets days in the given time zone, oldest first', async () => {
    const utc = await get<Stats>(alice.token, `/runs/stats?groupBy=day&tz=UTC&taskId=${taskA}`);
    expect(utc.timeZone).toBe('UTC');
    expect(utc.groups.map((g) => g.key)).toEqual(Array.from({ length: 10 }, (_, i) => new Date(T0 + i * DAY).toISOString().slice(0, 10)));
    const week = await get<Stats>(alice.token, `/runs/stats?groupBy=week&tz=UTC&taskId=${taskA}`);
    // 2026-06-01 is a Monday: days 0..6 and 7..9.
    expect(week.groups.map((g) => [g.key, g.runs])).toEqual([
      ['2026-06-01', 7],
      ['2026-06-08', 3],
    ]);
  });

  it('moves a run to the day of the time zone', async () => {
    // Bob's runs are at 12:00 UTC: 02:00 the next day in Kiritimati (UTC+14), still the same day in Costa Rica (UTC-6).
    const plus14 = await get<Stats>(bob.token, '/runs/stats?groupBy=day&tz=Pacific/Kiritimati');
    expect(plus14.groups.map((g) => g.key)).toEqual(['2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06']);
    const minus6 = await get<Stats>(bob.token, '/runs/stats?groupBy=day&tz=America/Costa_Rica');
    expect(minus6.groups.map((g) => g.key)[0]).toBe('2026-06-01');
  });

  it('agrees with the Consistency card on the same runs', async () => {
    const card = await get<{ steps: { median: number; p90: number; max: number } }>(alice.token, `/tasks/${taskA}/consistency?last=50`);
    const s = await get<Stats>(alice.token, `/runs/stats?taskId=${taskA}&state=finished`);
    expect([s.total.metrics.steps?.p50, s.total.metrics.steps?.p90, s.total.metrics.steps?.max]).toEqual([card.steps.median, card.steps.p90, card.steps.max]);
  });

  it('answers an empty total when nothing matches', async () => {
    const s = await get<Stats>(alice.token, '/runs/stats?q=no-such-goal&groupBy=task');
    expect(s.total.runs).toBe(0);
    expect(s.total.successRate).toBeNull();
    expect(s.total.metrics.costUsd).toBeNull();
    expect(s.groups).toEqual([]);
  });

  it("never counts another user's runs, and a filter on another user's task is empty", async () => {
    const s = await get<Stats>(bob.token, '/runs/stats');
    expect(s.total.runs).toBe(5);
    expect(s.total.metrics.steps?.max).toBe(999);
    const theirs = await get<Stats>(bob.token, `/runs/stats?taskId=${taskA}&groupBy=task`);
    expect(theirs.total.runs).toBe(0);
    expect(theirs.groups).toEqual([]);
  });

  it('carries no goal or result text', async () => {
    for (const by of ['none', 'task', 'policy', 'day']) {
      const res = await call(alice.token, `/runs/stats?groupBy=${by}`);
      expect(res.body).not.toContain('4111');
      expect(res.body).not.toContain(SECRET_GOAL);
    }
  });

  it('refuses a bad grouping, a bad time zone and a bad filter, and asks for a sign-in', async () => {
    expect((await call(alice.token, '/runs/stats?groupBy=goal')).statusCode).toBe(400);
    expect((await call(alice.token, '/runs/stats?tz=Mars/Base')).statusCode).toBe(400);
    expect((await call(alice.token, '/runs/stats?status=failed&state=live')).statusCode).toBe(400);
    expect((await call(null, '/runs/stats')).statusCode).toBe(401);
  });

  it('says so when more runs matched than it read', async () => {
    const s = await app.get(RunStatsService).stats(alice.userId, { taskId: taskA }, 'none', 'UTC', 4);
    expect(s.truncated).toBe(true);
    expect(s.scanned).toBe(4);
    // The newest four: steps 7..10.
    expect(s.total.metrics.steps).toMatchObject({ n: 4, sum: 34, max: 10 });
  });
});

describe('GET /runs/stats at scale', () => {
  it('answers 50,000 runs of one user quickly', async () => {
    const carol = await login('stats-carol');
    const statuses = ['succeeded', 'succeeded', 'succeeded', 'failed', 'cancelled'] as const;
    for (let batch = 0; batch < 10; batch++) {
      const data: Prisma.RunCreateManyInput[] = Array.from({ length: 5_000 }, (_, j) => {
        const n = batch * 5_000 + j;
        return { userId: carol.userId, goal: 'load', status: statuses[n % 5], stepCount: n % 97, modelCalls: n % 53, inputTokens: n % 9_973, outputTokens: n % 997, activeMs: n % 600_000, costUsd: (n % 1_000) / 10_000, createdAt: new Date(T0 - (n % 365) * DAY) };
      });
      await prisma.run.createMany({ data });
    }
    await get<Stats>(carol.token, '/runs/stats'); // warm up
    const times: number[] = [];
    let last: Stats | undefined;
    for (let i = 0; i < 5; i++) {
      const t = Date.now();
      last = await get<Stats>(carol.token, '/runs/stats?groupBy=day&tz=UTC');
      times.push(Date.now() - t);
    }
    times.sort((a, b) => a - b);
    // The measured number goes in the pull request; the bound only catches a regression by an order of magnitude.
    process.stdout.write(`run stats, 50,000 runs, groupBy=day: median ${times[2]} ms, max ${times[4]} ms\n`);
    try {
      expect(last!.total.runs).toBe(50_000);
      expect(last!.groups).toHaveLength(365);
      expect(times[2]).toBeLessThan(5_000);
    } finally {
      // The db tier shares one database per shard: 50,000 year-old runs left behind would make the next spec's nightly retention
      // job delete them all (run-retention.db.spec.ts timed out on exactly that).
      await prisma.$executeRaw`DELETE FROM runs WHERE user_id = ${carol.userId}::uuid`;
    }
  }, 180_000);
});

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
