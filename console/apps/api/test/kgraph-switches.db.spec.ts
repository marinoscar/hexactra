// E46.3 (#777) against a real database: the Prisma store passes the package's conformance kit; the switches are off by default, a task
// mode needs both switches on, turning a switch off keeps the data, another user's task is a 404, and "Delete everything learned" removes
// the caller's kg_ rows and nobody else's.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { runStoreConformance } from '@marinoscar/hexactra-kgraph/testing';

import { KgraphEnabledService } from '../src/kgraph/kgraph-enabled.service';
import { PrismaProcedureStore } from '../src/kgraph/prisma-procedure-store';
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
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `kg-${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
async function call<T = unknown>(s: Session, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<{ statusCode: number; data: T; code?: string }> {
  const res = await app.inject({ method, url: `/api${url}`, headers: { authorization: `Bearer ${s.token}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const body = res.body ? res.json<{ data?: T; code?: string; error?: { code?: string } }>() : undefined;
  return { statusCode: res.statusCode, data: body?.data as T, code: body?.code ?? body?.error?.code };
}
const newTask = async (s: Session, name: string) => (await call<{ id: string }>(s, 'POST', '/tasks', { name, goal: 'Look at example.test' })).data.id;

describe('the Prisma procedure store', () => {
  const sessions: Session[] = [];
  runStoreConformance({
    name: 'PostgreSQL (kg_ tables)',
    open: async () => {
      if (sessions.length === 0) sessions.push(await login('store-a'), await login('store-b'));
      const [a, b] = sessions as [Session, Session];
      await prisma.kgProcedure.deleteMany({ where: { id: { startsWith: 'kgc-' } } });
      const tasks = new Map<string, string>();
      return {
        store: new PrismaProcedureStore(prisma),
        owners: [a.userId, b.userId],
        task: async (owner: string, key: string) => {
          if (!tasks.has(key)) tasks.set(key, await newTask(owner === a.userId ? a : b, key));
          return tasks.get(key)!;
        },
        close: async () => {
          await prisma.kgProcedure.deleteMany({ where: { id: { startsWith: 'kgc-' } } });
        },
      };
    },
  });
});

describe('the Knowledge Graph switches (#777)', () => {
  let admin: Session;
  let owner: Session;
  let other: Session;
  beforeAll(async () => {
    admin = await login('admin', 'admin');
    owner = await login('owner');
    other = await login('other');
  });
  afterAll(async () => {
    await call(admin, 'PATCH', '/system-settings', { kgraph: { enabled: false } });
  });

  it('is off at the deployment and the user level by default, and a task mode is refused until both are on', async () => {
    expect((await call<{ kgraph: { enabled: boolean } }>(admin, 'GET', '/system-settings')).data.kgraph.enabled).toBe(false);
    expect((await call(owner, 'GET', '/kgraph/status')).data).toEqual({ deployment: false, user: false, available: false });
    const task = await newTask(owner, 'Refused');
    expect((await call(owner, 'GET', `/tasks/${task}/kgraph`)).data).toEqual({ taskId: task, mode: 'off', available: false });
    const refused = await call(owner, 'PUT', `/tasks/${task}/kgraph`, { mode: 'learn' });
    expect([refused.statusCode, refused.code]).toEqual([409, 'KGRAPH_OFF']);
    // An ordinary user cannot turn the deployment on.
    expect((await call(owner, 'PATCH', '/system-settings', { kgraph: { enabled: true } })).statusCode).toBe(403);
    expect((await call(admin, 'PATCH', '/system-settings', { kgraph: { enabled: true } })).statusCode).toBe(200);
    expect((await call(owner, 'PUT', `/tasks/${task}/kgraph`, { mode: 'learn' })).statusCode).toBe(409);
    expect((await call(owner, 'PATCH', '/user-settings', { kgraph: { enabled: true } })).statusCode).toBe(200);
    expect((await call(owner, 'GET', '/kgraph/status')).data).toEqual({ deployment: true, user: true, available: true });
    expect((await call(owner, 'PUT', `/tasks/${task}/kgraph`, { mode: 'learn' })).data).toEqual({ taskId: task, mode: 'learn', available: true });
    expect((await call(owner, 'PUT', `/tasks/${task}/kgraph`, { mode: 'fast' })).statusCode).toBe(400);
    const audit = await prisma.auditEvent.findFirst({ where: { actorUserId: owner.userId, action: 'kgraph.task_mode_changed' } });
    expect(audit?.meta).toEqual({ taskId: task, from: 'off', to: 'learn' });
  });

  it("answers another user's task with 404", async () => {
    const task = await newTask(owner, 'Mine');
    await call(other, 'PATCH', '/user-settings', { kgraph: { enabled: true } });
    for (const r of [await call(other, 'GET', `/tasks/${task}/kgraph`), await call(other, 'PUT', `/tasks/${task}/kgraph`, { mode: 'reuse' })]) expect([r.statusCode, r.code]).toEqual([404, 'KGRAPH_TASK_NOT_FOUND']);
  });

  it('keeps the data when any switch is turned off, and resumes with it when turned back on', async () => {
    const gate = app.get(KgraphEnabledService);
    const store = app.get(PrismaProcedureStore);
    const task = await newTask(owner, 'Kept');
    await call(owner, 'PUT', `/tasks/${task}/kgraph`, { mode: 'reuse' });
    await store.putProcedure({ id: `kgk-${stamp}`, owner: owner.userId, task, name: 'Kept', activeVersion: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const mode = () => gate.modeFor({ userId: owner.userId, taskId: task, run: { isTaskRun: true } });
    const kept = async () => (await store.findProcedureForTask(owner.userId, task)) !== null;
    expect(await mode()).toBe('reuse');
    expect(await gate.modeFor({ userId: owner.userId, taskId: task, run: { isTaskRun: true, aiOnly: true } })).toBe('off');
    expect(await gate.modeFor({ userId: owner.userId, taskId: task, run: { isTaskRun: false } })).toBe('off');

    await call(admin, 'PATCH', '/system-settings', { kgraph: { enabled: false } });
    expect([await mode(), await kept()]).toEqual(['off', true]);
    await call(admin, 'PATCH', '/system-settings', { kgraph: { enabled: true } });
    expect([await mode(), await kept()]).toEqual(['reuse', true]);

    await call(owner, 'PATCH', '/user-settings', { kgraph: { enabled: false } });
    expect([await mode(), await kept()]).toEqual(['off', true]);
    expect((await call(owner, 'GET', `/tasks/${task}/kgraph`)).data).toEqual({ taskId: task, mode: 'reuse', available: false });
    await call(owner, 'PATCH', '/user-settings', { kgraph: { enabled: true } });
    expect([await mode(), await kept()]).toEqual(['reuse', true]);

    await call(owner, 'PUT', `/tasks/${task}/kgraph`, { mode: 'off' });
    expect([await mode(), await kept()]).toEqual(['off', true]);
    await call(owner, 'PUT', `/tasks/${task}/kgraph`, { mode: 'reuse' });
    expect([await mode(), await kept()]).toEqual(['reuse', true]);
  });

  it("deletes every kg_ row of the caller and none of anyone else's", async () => {
    const store = app.get(PrismaProcedureStore);
    const mine = await newTask(owner, 'Purge mine');
    const theirs = await newTask(other, 'Purge theirs');
    await call(owner, 'PUT', `/tasks/${mine}/kgraph`, { mode: 'learn' });
    await call(other, 'PUT', `/tasks/${theirs}/kgraph`, { mode: 'learn' });
    const at = new Date().toISOString();
    await store.putProcedure({ id: `kgp-mine-${stamp}`, owner: owner.userId, task: mine, name: 'x', activeVersion: null, createdAt: at, updatedAt: at });
    await store.putProcedure({ id: `kgp-theirs-${stamp}`, owner: other.userId, task: theirs, name: 'y', activeVersion: null, createdAt: at, updatedAt: at });
    await prisma.kgNode.create({ data: { id: `kgn-mine-${stamp}`, userId: owner.userId, type: 'Site', key: 'example.com', label: 'example.com' } });
    await prisma.kgNode.create({ data: { id: `kgn-theirs-${stamp}`, userId: other.userId, type: 'Site', key: 'example.com', label: 'example.com' } });

    const res = await call<{ deleted: Record<string, number> }>(owner, 'DELETE', '/kgraph');
    expect(res.statusCode).toBe(200);
    expect(res.data.deleted.procedures).toBeGreaterThanOrEqual(1);
    const left = async (userId: string) =>
      (await Promise.all([prisma.kgProcedure.count({ where: { userId } }), prisma.kgNode.count({ where: { userId } }), prisma.kgTaskSettings.count({ where: { userId } }), prisma.kgProcedureVersion.count({ where: { userId } }), prisma.kgEvidence.count({ where: { userId } })])).reduce((a, b) => a + b, 0);
    expect(await left(owner.userId)).toBe(0);
    expect(await left(other.userId)).toBeGreaterThanOrEqual(3);
    expect(await prisma.auditEvent.count({ where: { actorUserId: owner.userId, action: 'kgraph.purged' } })).toBe(1);
    // A viewer-less caller without kgraph:write cannot purge: an unauthenticated one is refused.
    expect((await app.inject({ method: 'DELETE', url: '/api/kgraph' })).statusCode).toBe(401);
  });
});
