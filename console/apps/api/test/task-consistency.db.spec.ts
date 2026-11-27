// GET /api/tasks/{id}/consistency (E52.7, #1022) against a real database: finished runs only, benchmark runs left out, `last` and
// `since`, the owner's task only, and the step reads bounded to the 10 newest runs.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { RunInsightsService } from '../src/run-insights/run-insights.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = Date.now();

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app?.close();
});

async function login(email: string): Promise<{ token: string; userId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  return { token, userId: (await prisma.user.findFirstOrThrow({ where: { email }, select: { id: true } })).id };
}

async function taskWithRuns(userId: string, runs: { steps: number; status?: 'succeeded' | 'failed' | 'running'; trigger?: 'manual' | 'benchmark'; minutesAgo: number }[]) {
  const db = prisma.forUser({ userId });
  const task = await db.task.create({ data: { userId, name: 'Send a text', goal: 'Send a text message to {{Recipient}} saying "{{Message}}".' } });
  for (const r of runs) {
    await db.run.create({ data: { userId, taskId: task.id, goal: 'Send a text message', status: r.status ?? 'succeeded', trigger: r.trigger ?? 'manual', stepCount: r.steps, modelCalls: r.steps, createdAt: new Date(Date.now() - r.minutesAgo * 60_000) } });
  }
  return task.id;
}

const get = (taskId: string, token: string, query = '') => app.inject({ method: 'GET', url: `/api/tasks/${taskId}/consistency${query}`, headers: { authorization: `Bearer ${token}` } });

describe('GET /api/tasks/{id}/consistency', () => {
  it('counts the finished runs, leaves out live and benchmark runs, and labels the spread', async () => {
    const owner = await login(`cons-${stamp}@example.test`);
    const taskId = await taskWithRuns(owner.userId, [
      { steps: 33, minutesAgo: 1 },
      { steps: 43, minutesAgo: 2 },
      { steps: 35, minutesAgo: 3 },
      { steps: 124, minutesAgo: 4 },
      { steps: 500, status: 'running', minutesAgo: 0 },
      { steps: 900, trigger: 'benchmark', minutesAgo: 5 },
    ]);
    const res = await get(taskId, owner.token);
    expect(res.statusCode).toBe(200);
    const c = res.json<{ data: { runs: number; label: string; steps: { median: number; max: number }; perRun: { stepCount: number }[] } }>().data;
    expect(c).toMatchObject({ runs: 4, label: 'erratic', steps: { median: 39, max: 124 } });
    expect(c.perRun.map((r) => r.stepCount)).toEqual([33, 43, 35, 124]);
  });

  it('honours last and since, and refuses a last outside 3 to 50', async () => {
    const owner = await login(`cons-q-${stamp}@example.test`);
    const taskId = await taskWithRuns(owner.userId, [{ steps: 10, minutesAgo: 1 }, { steps: 11, minutesAgo: 2 }, { steps: 12, minutesAgo: 3 }, { steps: 99, minutesAgo: 600 }]);
    expect((await get(taskId, owner.token, '?last=3')).json<{ data: { runs: number } }>().data.runs).toBe(3);
    const since = new Date(Date.now() - 10 * 60_000).toISOString();
    expect((await get(taskId, owner.token, `?since=${encodeURIComponent(since)}`)).json<{ data: { runs: number; label: string } }>().data).toMatchObject({ runs: 3, label: 'steady' });
    expect((await get(taskId, owner.token, '?last=2')).statusCode).toBe(400);
    expect((await get(taskId, owner.token, '?last=51')).statusCode).toBe(400);
  });

  it('is a 404 for another user', async () => {
    const owner = await login(`cons-a-${stamp}@example.test`);
    const other = await login(`cons-b-${stamp}@example.test`);
    const taskId = await taskWithRuns(owner.userId, [{ steps: 10, minutesAgo: 1 }]);
    expect((await get(taskId, other.token)).statusCode).toBe(404);
  });

  it('reads the steps of the 10 newest runs only', async () => {
    const owner = await login(`cons-n-${stamp}@example.test`);
    const taskId = await taskWithRuns(owner.userId, Array.from({ length: 14 }, (_, i) => ({ steps: 10 + i, minutesAgo: i + 1 })));
    const insights = app.get(RunInsightsService);
    const spy = jest.spyOn(insights, 'diagnostics');
    await insights.consistency(owner.userId, taskId, 20, null);
    expect(spy).toHaveBeenCalledTimes(10);
    spy.mockRestore();
  });
});
