// Schedules against a real database with a fixed clock: due firings start
// runs, a live run makes a "skip" schedule wait, failures are counted.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { WebhooksService, webhookEventRegistry } from '@marinoscar/platform-api/webhooks';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { SchedulesService } from '../src/schedules/schedules.service';

let app: NestFastifyApplication;
const stamp = `${Date.now()}`;

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
});

async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}

describe('schedules', () => {
  it('validates input over HTTP and starts due runs on the tick', async () => {
    const { token, userId } = await login(`sched-${stamp}@example.test`);
    const headers = { authorization: `Bearer ${token}` };
    const prisma = app.get(PrismaService);
    const schedules = app.get(SchedulesService);
    const task = await prisma.forUser({ userId }).task.create({ data: { userId, name: 'Daily', goal: 'Check the fare' } });

    const bad = await app.inject({ method: 'POST', url: '/api/schedules', headers, payload: { taskId: task.id, cron: '* * * * *' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('at most every 5 minutes');
    const created = await app.inject({ method: 'POST', url: '/api/schedules', headers, payload: { taskId: task.id, cron: '0 9 * * *', timezone: 'Europe/Madrid' } });
    expect(created.statusCode).toBe(201);
    const s = created.json<{ data: { id: string; nextRunAt: string } }>().data;
    expect(new Date(s.nextRunAt).getTime()).toBeGreaterThan(Date.now());

    // Fake clock: the firing is due.
    const now = new Date(new Date(s.nextRunAt).getTime() + 1_000);
    const first = await schedules.tick(now);
    expect(first.started).toBeGreaterThanOrEqual(1);
    const runs = await prisma.forUser({ userId }).run.findMany({ where: { taskId: task.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: 'schedule', goal: 'Check the fare', status: 'queued' });
    const job = await prisma.job.findFirst({ where: { type: 'browser.goal.run', subjectId: runs[0]!.id } });
    expect(job).not.toBeNull();

    // The next firing comes while that run is still live: skipped.
    const after = await prisma.taskSchedule.findUniqueOrThrow({ where: { id: s.id } });
    const second = await schedules.tick(new Date(after.nextRunAt!.getTime() + 1_000));
    expect(second.skipped).toBeGreaterThanOrEqual(1);
    expect(await prisma.run.count({ where: { taskId: task.id } })).toBe(1);

    // Three failed runs in a row make it "failing".
    let failing: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const cur = await prisma.taskSchedule.findUniqueOrThrow({ where: { id: s.id } });
      await prisma.run.updateMany({ where: { taskId: task.id, status: { in: ['queued', 'running'] } }, data: { status: 'failed' } });
      const r = await schedules.tick(new Date(cur.nextRunAt!.getTime() + 1_000));
      failing = failing.concat(r.failing.filter((f) => f.scheduleId === s.id));
    }
    expect(failing).toEqual([expect.objectContaining({ scheduleId: s.id, taskName: 'Daily', failures: 3 })]);
  });
});

describe('run events as webhooks', () => {
  it('registers the console events and validates their payloads', async () => {
    const { userId } = await login(`hooks-${stamp}@example.test`);
    const keys = webhookEventRegistry.list().map((e: { key: string }) => e.key);
    expect(keys).toEqual(expect.arrayContaining(['runs.run.started', 'runs.run.waiting', 'runs.run.finished', 'schedules.schedule.failing']));
    const hooks = app.get(WebhooksService);
    const ok = await hooks.emitForUser(userId, 'runs.run.finished', {
      runId: '00000000-0000-4000-8000-000000000001',
      taskId: null,
      goal: 'g',
      trigger: 'manual',
      status: 'succeeded',
      result: 'done',
    });
    expect(ok).toMatchObject({ matched: 0, queued: 0 }); // no endpoint subscribed yet
  });
});
