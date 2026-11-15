// The db tier: tasks and runs against a real, migrated and seeded database.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { TasksService } from '../src/tasks/tasks.service';

let app: NestFastifyApplication;
const run = `${Date.now()}`;

async function login(email: string, role: 'admin' | 'contributor' | 'viewer'): Promise<{ token: string; userId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
const as = (token: string) => ({ authorization: `Bearer ${token}` });
const body = <T,>(res: { json: <U>() => U }): T => res.json<{ data: T }>().data;

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
});

describe('tasks and runs, end to end', () => {
  it('lets a contributor manage tasks only they can see; a viewer only reads', async () => {
    const alice = await login(`alice-${run}@example.test`, 'contributor');
    const bob = await login(`bob-${run}@example.test`, 'contributor');
    const viewer = await login(`vic-${run}@example.test`, 'viewer');

    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: as(alice.token),
      payload: { name: 'Check flight', goal: 'Find the cheapest fare', profile: 'travel', allowedDomains: ['flights.example.test'] },
    });
    expect(created.statusCode).toBe(201);
    const task = body<{ id: string; maxSteps: number; profile: string }>(created);
    expect(task).toMatchObject({ maxSteps: 40, profile: 'travel' });

    expect(body<{ id: string }[]>(await app.inject({ method: 'GET', url: '/api/tasks', headers: as(bob.token) })).map((t) => t.id)).not.toContain(task.id);
    expect((await app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, headers: as(bob.token), payload: { name: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/tasks', headers: as(viewer.token), payload: { name: 'x', goal: 'y' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/tasks', headers: as(viewer.token) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/tasks' })).statusCode).toBe(401);
  });

  it('enforces the run state machine and cancels a queued run at once', async () => {
    const alice = await login(`alice2-${run}@example.test`, 'contributor');
    const prisma = app.get(PrismaService);
    const tasks = app.get(TasksService);
    const r = await prisma.forUser({ userId: alice.userId }).run.create({ data: { userId: alice.userId, goal: 'g' } });

    const running = await tasks.transition(alice.userId, r.id, 'running');
    expect(running.status).toBe('running');
    expect(running.startedAt).not.toBeNull();
    await expect(tasks.transition(alice.userId, r.id, 'queued')).rejects.toThrow(/cannot go from running to queued/);

    // Cancel while running only flags it; the runner stops between steps.
    const res = await app.inject({ method: 'POST', url: `/api/runs/${r.id}/cancel`, headers: as(alice.token) });
    expect(body<{ cancelRequested: boolean; status: string }>(res)).toMatchObject({ cancelRequested: true, status: 'running' });

    const done = await tasks.transition(alice.userId, r.id, 'succeeded', { result: 'ok' });
    expect(done.finishedAt).not.toBeNull();
    await expect(tasks.transition(alice.userId, r.id, 'running')).rejects.toThrow();

    const queued = await prisma.forUser({ userId: alice.userId }).run.create({ data: { userId: alice.userId, goal: 'g' } });
    const cancelled = await app.inject({ method: 'POST', url: `/api/runs/${queued.id}/cancel`, headers: as(alice.token) });
    expect(body<{ status: string }>(cancelled).status).toBe('cancelled');

    const read = await app.inject({ method: 'GET', url: `/api/runs/${r.id}`, headers: as(alice.token) });
    const detail = body<{ steps: unknown[]; transcript?: unknown }>(read);
    expect(detail.steps).toEqual([]);
    expect(detail).not.toHaveProperty('transcript');
  });
});
