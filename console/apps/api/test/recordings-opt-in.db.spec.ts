// E45.3 (#758) against a real database: a task's `recordVideo` and a start
// request's `record` fix the run's `recordVideo` when the run is created, and
// the `recordings` system settings are admin-only.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;

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

type Session = { token: string; userId: string };
async function login(name: string, role: 'contributor' | 'admin' = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `rec-${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
async function call<T = unknown>(s: Session, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown): Promise<{ statusCode: number; data: T }> {
  const res = await app.inject({ method, url: `/api${url}`, headers: { authorization: `Bearer ${s.token}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { statusCode: res.statusCode, data: (res.body ? res.json<{ data?: T }>().data : undefined) as T };
}

describe('recording opt-in (#758)', () => {
  let owner: Session;
  beforeAll(async () => {
    owner = await login('owner');
  });

  it('is off by default and follows the task, or the request for one run', async () => {
    const plain = await call<{ id: string; recordVideo: boolean }>(owner, 'POST', '/tasks', { name: 'Plain', goal: 'Look at example.test' });
    expect(plain.statusCode).toBe(201);
    expect(plain.data.recordVideo).toBe(false);
    const recorded = await call<{ id: string; recordVideo: boolean }>(owner, 'POST', '/tasks', { name: 'Recorded', goal: 'Look at example.test', recordVideo: true });
    expect(recorded.data.recordVideo).toBe(true);

    const runOf = async (taskId: string, body?: object) => {
      const r = await call<{ id: string; recordVideo: boolean }>(owner, 'POST', `/tasks/${taskId}/runs`, body);
      expect(r.statusCode).toBe(201);
      return prisma.run.findUniqueOrThrow({ where: { id: r.data.id }, select: { recordVideo: true } });
    };
    expect((await runOf(plain.data.id)).recordVideo).toBe(false);
    expect((await runOf(recorded.data.id)).recordVideo).toBe(true);
    expect((await runOf(recorded.data.id, { record: false })).recordVideo).toBe(false);
    expect((await runOf(plain.data.id, { record: true })).recordVideo).toBe(true);

    const patched = await call<{ recordVideo: boolean }>(owner, 'PATCH', `/tasks/${plain.data.id}`, { recordVideo: true });
    expect(patched.data.recordVideo).toBe(true);
  });

  it('takes `record` on an ad-hoc run, off by default', async () => {
    const off = await call<{ id: string }>(owner, 'POST', '/runs', { goal: 'Look at example.test' });
    const on = await call<{ id: string }>(owner, 'POST', '/runs', { goal: 'Look at example.test', record: true });
    expect((await prisma.run.findUniqueOrThrow({ where: { id: off.data.id } })).recordVideo).toBe(false);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: on.data.id } })).recordVideo).toBe(true);
  });

  it('keeps the retention settings for administrators, 30 days by default', async () => {
    const admin = await login('admin', 'admin');
    const doc = await call<{ recordings: { keepDays: number | null; maxMinutes: number } }>(admin, 'GET', '/system-settings');
    expect(doc.data.recordings).toEqual({ keepDays: 30, maxMinutes: 60 });
    expect((await call(owner, 'PATCH', '/system-settings', { recordings: { keepDays: null } })).statusCode).toBe(403);
    expect((await call(admin, 'PATCH', '/system-settings', { recordings: { keepDays: 0 } })).statusCode).toBe(400);
    expect((await call(admin, 'PATCH', '/system-settings', { recordings: { keepDays: null } })).statusCode).toBe(200);
    const after = await call<{ recordings: { keepDays: number | null } }>(admin, 'GET', '/system-settings');
    expect(after.data.recordings.keepDays).toBeNull();
    await call(admin, 'PATCH', '/system-settings', { recordings: { keepDays: 30 } });
  });
});
