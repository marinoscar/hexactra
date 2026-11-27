// E46.3 (#777) against a real database: the Prisma store passes the package's conformance kit; the switches are off by default, a task
// mode needs both switches on, turning a switch off keeps the data, another user's task is a 404, and "Delete everything learned" removes
// the caller's kg_ rows and nobody else's.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Prisma } from '@prisma/client';
import { procedureVersionSchema } from '@marinoscar/hexactra-kgraph';
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
    expect((await call(owner, 'GET', '/kgraph/status')).data).toEqual({ deployment: false, user: false, available: false, everyday: false, autoApproveFacts: false });
    const task = await newTask(owner, 'Refused');
    // A task the owner never set reads Learn only (#1031); with a switch off it is not available, so no run captures anything.
    expect((await call(owner, 'GET', `/tasks/${task}/kgraph`)).data).toEqual({ taskId: task, mode: 'learn', available: false });
    const refused = await call(owner, 'PUT', `/tasks/${task}/kgraph`, { mode: 'learn' });
    expect([refused.statusCode, refused.code]).toEqual([409, 'KGRAPH_OFF']);
    // An ordinary user cannot turn the deployment on.
    expect((await call(owner, 'PATCH', '/system-settings', { kgraph: { enabled: true, pacing: 'fast' } })).statusCode).toBe(403);
    expect((await call(admin, 'PATCH', '/system-settings', { kgraph: { enabled: true, pacing: 'fast' } })).statusCode).toBe(200);
    expect((await call(owner, 'PUT', `/tasks/${task}/kgraph`, { mode: 'learn' })).statusCode).toBe(409);
    expect((await call(owner, 'PATCH', '/user-settings', { kgraph: { enabled: true } })).statusCode).toBe(200);
    expect((await call(owner, 'GET', '/kgraph/status')).data).toEqual({ deployment: true, user: true, available: true, everyday: false, autoApproveFacts: false });
    expect((await call(owner, 'PUT', `/tasks/${task}/kgraph`, { mode: 'reuse' })).data).toEqual({ taskId: task, mode: 'reuse', available: true });
    expect((await call(owner, 'PUT', `/tasks/${task}/kgraph`, { mode: 'fast' })).statusCode).toBe(400);
    const audit = await prisma.auditEvent.findFirst({ where: { actorUserId: owner.userId, action: 'kgraph.task_mode_changed' } });
    expect(audit?.meta).toEqual({ taskId: task, from: 'learn', to: 'reuse' });
  });

  it('a task the owner never set learns by default once both switches are on; an explicit AI only is kept (#1031)', async () => {
    const gate = app.get(KgraphEnabledService);
    const fresh = await newTask(owner, 'Default');
    const chosen = await newTask(owner, 'Chosen off');
    const mode = (taskId: string) => gate.modeFor({ userId: owner.userId, taskId, run: { isTaskRun: true } });
    expect(await mode(fresh)).toBe('learn');
    expect((await call(owner, 'GET', `/tasks/${fresh}/kgraph`)).data).toEqual({ taskId: fresh, mode: 'learn', available: true });
    // "Run with AI only this time" and a chat still never learn.
    expect(await gate.modeFor({ userId: owner.userId, taskId: fresh, run: { isTaskRun: true, aiOnly: true } })).toBe('off');
    expect(await gate.modeFor({ userId: owner.userId, taskId: fresh, run: { isTaskRun: false } })).toBe('off');
    await call(owner, 'PUT', `/tasks/${chosen}/kgraph`, { mode: 'off' });
    expect(await mode(chosen)).toBe('off');
    // Either switch off: nothing learns, the default included.
    await call(owner, 'PATCH', '/user-settings', { kgraph: { enabled: false } });
    expect(await mode(fresh)).toBe('off');
    await call(owner, 'PATCH', '/user-settings', { kgraph: { enabled: true } });
    await call(admin, 'PATCH', '/system-settings', { kgraph: { enabled: false } });
    expect(await mode(fresh)).toBe('off');
    await call(admin, 'PATCH', '/system-settings', { kgraph: { enabled: true, pacing: 'fast' } });
    expect(await mode(fresh)).toBe('learn');
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
    await call(admin, 'PATCH', '/system-settings', { kgraph: { enabled: true, pacing: 'fast' } });
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
    // E46.37 (#893): one row in EVERY kg_ table for two owners (the list is Prisma's, so a new kg_ table fails here until it is seeded),
    // then the owner's purge: each of the owner's tables is empty, the other owner's rows are all still there, and the read routes the
    // Knowledge Graph pages call answer empty (what KgraphPurge.test.tsx renders as the empty states).
    const store = app.get(PrismaProcedureStore);
    const at = new Date().toISOString();
    const seed = async (s: Session, tag: string) => {
      const task = await newTask(s, `Purge ${tag}`);
      const pid = `kgp-${tag}-${stamp}`;
      const vid = `kgv-${tag}-${stamp}`;
      await store.putProcedure({ id: pid, owner: s.userId, task, name: tag, activeVersion: null, createdAt: at, updatedAt: at });
      await store.putVersion(
        s.userId,
        procedureVersionSchema.parse({
          id: vid, procedure: pid, number: 1, state: 'active', changeClass: 'initial', sourceRun: null, parent: null, createdAt: at, entry: 's1',
          sites: [{ id: 'site1', domain: 'shop.example.test' }], parameters: [], outputs: [],
          steps: [{ id: 's1', kind: 'call', label: 'Open the shop', tool: 'navigate', sites: ['site1'], args: { url: { kind: 'literal', value: 'https://shop.example.test/' } } }],
          edges: [],
        }),
      );
      await store.putProcedure({ id: pid, owner: s.userId, task, name: tag, activeVersion: vid, createdAt: at, updatedAt: at });
      await store.recordEvidence(s.userId, vid, 's1', 'success', at);
      const runId = (await prisma.forUser({ userId: s.userId }).run.create({ data: { userId: s.userId, taskId: task, goal: 'Open the shop', status: 'succeeded', finishedAt: new Date() } as never })).id;
      await prisma.kgTaskSettings.create({ data: { taskId: task, userId: s.userId, mode: 'reuse' } });
      await prisma.kgRun.create({ data: { runId, userId: s.userId, mode: 'reuse', procedureVersionId: vid, outcome: 'replayed', stepsReplayed: 1, factIds: [`kgsf-${tag}-${stamp}`] } });
      await prisma.kgTrace.create({ data: { userId: s.userId, runId, seq: 1, tool: 'navigate', family: 'browser', ok: true, outcome: 'ran' } });
      await prisma.kgLedger.create({ data: { runId, userId: s.userId, taskId: task, mode: 'reuse', procedureVersionId: vid, runStatus: 'succeeded', stepsReplayed: 1, outcome: 'replayed', finishedAt: new Date() } });
      await prisma.kgNode.create({ data: { id: `kgn-${tag}-${stamp}`, userId: s.userId, type: 'Site', key: 'shop.example.test', label: 'shop.example.test' } });
      await prisma.kgEdge.create({ data: { id: `kge-${tag}-${stamp}`, userId: s.userId, type: 'uses', fromId: `kgn-${tag}-${stamp}`, toId: `kgn-${tag}-${stamp}` } });
      await prisma.kgReview.create({ data: { userId: s.userId, versionId: vid, summary: [] } });
      await prisma.kgSiteFact.create({ data: { id: `kgsf-${tag}-${stamp}`, userId: s.userId, site: 'shop.example.test', kind: 'navigation', text: 'Invoices are under Billing', identity: `nav-${tag}-${stamp}`, source: 'owner', status: 'active', createdAt: new Date() } });
      await prisma.kgSiteFact.create({ data: { id: `kgsf-p-${tag}-${stamp}`, userId: s.userId, site: 'shop.example.test', kind: 'timing', text: 'Reports take a minute', identity: `timing-${tag}-${stamp}`, source: 'derived', status: 'proposed', createdAt: new Date() } });
      return { task, runId };
    };
    const delegates = Object.values(Prisma.ModelName).filter((m) => m.startsWith('Kg'));
    const countsOf = async (userId: string): Promise<Record<string, number>> =>
      Object.fromEntries(await Promise.all(delegates.map(async (m) => [m, await (prisma as unknown as Record<string, { count(a: object): Promise<number> }>)[m.charAt(0).toLowerCase() + m.slice(1)]!.count({ where: { userId } })])));
    const mine = await seed(owner, 'mine');
    await seed(other, 'theirs');
    const otherBefore = await countsOf(other.userId);
    const ownerBefore = await countsOf(owner.userId);
    // Every kg_ table holds a row of each owner before the purge.
    expect(delegates.length).toBeGreaterThanOrEqual(11);
    for (const userId of [owner.userId, other.userId]) for (const [m, n] of Object.entries(await countsOf(userId))) expect([m, n > 0]).toEqual([m, true]);

    const res = await call<{ deleted: Record<string, number> }>(owner, 'DELETE', '/kgraph');
    expect(res.statusCode).toBe(200);
    // The response counts exactly the owner's rows of each table (earlier tests of this file left more of the owner's).
    const KEY: Record<string, string> = { KgProcedure: 'procedures', KgProcedureVersion: 'versions', KgEvidence: 'evidence', KgTrace: 'traces', KgNode: 'nodes', KgEdge: 'edges', KgLedger: 'ledger', KgSiteFact: 'siteFacts', KgRun: 'runs', KgReview: 'reviews', KgTaskSettings: 'tasks' };
    expect(Object.keys(KEY).sort()).toEqual([...delegates].sort());
    expect(res.data.deleted).toEqual(Object.fromEntries(Object.entries(KEY).map(([m, k]) => [k, ownerBefore[m]])));
    expect(Object.values(await countsOf(owner.userId)).every((n) => n === 0)).toBe(true);
    expect(await countsOf(owner.userId)).toEqual(Object.fromEntries(delegates.map((m) => [m, 0])));
    expect(await countsOf(other.userId)).toEqual(otherBefore);
    expect(await prisma.auditEvent.count({ where: { actorUserId: owner.userId, action: 'kgraph.purged' } })).toBe(1);
    // The owner's tasks and runs stay; only what was learned goes.
    expect(await prisma.run.count({ where: { id: mine.runId } })).toBe(1);
    expect(await prisma.task.count({ where: { id: mine.task } })).toBe(1);

    // What the pages read after it: every list empty, the run "took no part".
    expect((await call<{ procedures: unknown[] }>(owner, 'GET', '/kgraph/procedures')).data.procedures).toEqual([]);
    expect((await call<unknown[]>(owner, 'GET', '/kgraph/reviews?status=pending')).data).toEqual([]);
    expect((await call<unknown[]>(owner, 'GET', '/kgraph/reviews/site-facts')).data).toEqual([]);
    expect((await call<unknown[]>(owner, 'GET', '/kgraph/sites')).data).toEqual([]);
    expect((await call<{ nodes: unknown[] }>(owner, 'GET', '/kgraph/graph')).data.nodes).toEqual([]);
    expect((await call(owner, 'GET', `/kgraph/runs/${mine.runId}`)).data).toMatchObject({ mode: 'off', aiOnly: false, procedureId: null, steps: [], ledger: null, kgFactIds: [], siteFacts: [] });
    // An unauthenticated caller cannot purge.
    expect((await app.inject({ method: 'DELETE', url: '/api/kgraph' })).statusCode).toBe(401);
  });
});
