// Admin run statistics (E53.2, #1070) against a real database: the same statistics across the deployment, behind
// `run_stats:read_all`, aggregates only: no goal, result, step text or another user's task name ever leaves.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Prisma } from '@prisma/client';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;
// A window no other spec (and no earlier run of this one) writes runs in: the admin totals count every user of the shared test
// database. 11 days per run, from 2041 on.
const T0 = Date.parse('2041-03-01T12:00:00.000Z') + (Date.now() % 3_000) * 11 * 86_400_000;
const SECRET_GOAL = `Wire the money to account 12345678 ${stamp}`;
const SECRET_TASK = `Payroll for Ana ${stamp}`;

async function login(name: string, role: string): Promise<{ token: string; userId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
const call = (token: string, url: string) => app.inject({ method: 'GET', url: `/api${url}`, headers: { authorization: `Bearer ${token}` } });

interface Group {
  key: string;
  label: string;
  runs: number;
  metrics: Record<string, { sum: number; max: number } | null>;
}
interface Stats {
  groupBy: string;
  total: { runs: number; finished: number; metrics: Record<string, { sum: number } | null> };
  groups: Group[];
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

describe('GET /admin/runs/stats', () => {
  let admin: { token: string; userId: string };
  let alice: { token: string; userId: string };
  let bob: { token: string; userId: string };
  let taskId: string;
  const from = new Date(T0 - 1_000).toISOString();
  const to = new Date(T0 + 10 * 86_400_000).toISOString();

  beforeAll(async () => {
    admin = await login('stats-admin', 'org_admin');
    alice = await login('stats-a', 'contributor');
    bob = await login('stats-b', 'contributor');
    taskId = (await prisma.task.create({ data: { userId: alice.userId, name: SECRET_TASK, goal: SECRET_GOAL } })).id;
    const data: Prisma.RunCreateManyInput[] = [
      ...Array.from({ length: 3 }, (_, i) => ({ userId: alice.userId, taskId, goal: SECRET_GOAL, result: `Sent to ${SECRET_GOAL}`, status: 'succeeded' as const, stepCount: 10 + i, costUsd: 0.1, createdAt: new Date(T0 + i * 3_600_000) })),
      { userId: bob.userId, goal: SECRET_GOAL, status: 'failed' as const, stopReason: 'stalled' as const, stepCount: 50, costUsd: 0.5, createdAt: new Date(T0 + 86_400_000) },
    ];
    await prisma.run.createMany({ data });
  });

  it('refuses a caller without run_stats:read_all', async () => {
    expect((await call(alice.token, `/admin/runs/stats?from=${from}&to=${to}`)).statusCode).toBe(403);
  });

  it("counts every user's runs, and the totals equal the sum of each user's own statistics", async () => {
    const all = (await call(admin.token, `/admin/runs/stats?from=${from}&to=${to}`)).json<{ data: Stats }>().data;
    const mine = await Promise.all(
      [alice, bob, admin].map(async (u) => (await call(u.token, `/runs/stats?from=${from}&to=${to}`)).json<{ data: Stats }>().data),
    );
    expect(all.total.runs).toBe(mine.reduce((n, s) => n + s.total.runs, 0));
    expect(all.total.metrics.steps?.sum).toBe(mine.reduce((n, s) => n + (s.total.metrics.steps?.sum ?? 0), 0));
    expect(all.total.runs).toBeGreaterThanOrEqual(4);
  });

  it('groups by user, labelled by id and display name only', async () => {
    const s = (await call(admin.token, `/admin/runs/stats?from=${from}&to=${to}&groupBy=user`)).json<{ data: Stats }>().data;
    const byUser = Object.fromEntries(s.groups.map((g) => [g.key, g.runs]));
    expect(byUser[alice.userId]).toBe(3);
    expect(byUser[bob.userId]).toBe(1);
    for (const g of s.groups) expect(g.label).not.toContain('@');
  });

  it('never names another user task, never carries a goal or a result', async () => {
    for (const by of ['none', 'user', 'task', 'policy', 'stopReason', 'day']) {
      const res = await call(admin.token, `/admin/runs/stats?from=${from}&to=${to}&groupBy=${by}`);
      expect([by, res.statusCode]).toEqual([by, 200]);
      expect(res.body).not.toContain('12345678');
      expect(res.body).not.toContain(SECRET_TASK);
    }
    const byTask = (await call(admin.token, `/admin/runs/stats?from=${from}&to=${to}&groupBy=task`)).json<{ data: Stats }>().data;
    expect(byTask.groups.find((g) => g.key === taskId)?.label).toBe(`Task ${taskId.slice(0, 8)}`);
  });

  it('refuses a goal search, and the per-user route still refuses groupBy=user', async () => {
    expect((await call(admin.token, '/admin/runs/stats?q=money')).statusCode).toBe(400);
    expect((await call(alice.token, '/runs/stats?groupBy=user')).statusCode).toBe(400);
  });

  it('writes an audit event with the names of the filters, never their values', async () => {
    await call(admin.token, `/admin/runs/stats?from=${from}&groupBy=user`);
    const rows = await prisma.$queryRaw<{ meta: unknown }[]>`SELECT meta FROM audit_events WHERE action = 'runs.stats_admin_read' AND actor_user_id = ${admin.userId}::uuid ORDER BY created_at DESC LIMIT 1`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toMatchObject({ groupBy: 'user', filters: ['from'] });
    expect(JSON.stringify(rows[0]!.meta)).not.toContain(from);
  });
});
