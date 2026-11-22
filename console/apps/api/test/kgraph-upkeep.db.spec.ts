// E46.24 (#798) against a real database: each upkeep action before and after; a user with the switch off is untouched; a second run
// changes nothing; an active version's bytes are equal before and after.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { procedureVersionSchema } from '@marinoscar/hexactra-kgraph';

import { PrismaProcedureStore } from '../src/kgraph/prisma-procedure-store';
import { KgraphUpkeepService } from '../src/kgraph/upkeep.service';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;
beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app?.close();
});
async function login(email: string, role: 'contributor' | 'admin' = 'contributor') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { userId: me.json<{ data: { id: string } }>().data.id, token };
}
const patch = (token: string, url: string, payload: object) => app.inject({ method: 'PATCH', url: `/api${url}`, headers: { authorization: `Bearer ${token}` }, payload });

describe('library upkeep (#798)', () => {
  let admin: { token: string };
  beforeAll(async () => {
    admin = await login(`kgup-admin-${stamp}@example.test`, 'admin');
    await patch(admin.token, '/system-settings', { kgraph: { enabled: true, retentionDays: 30 } });
  });
  afterAll(async () => {
    await patch(admin.token, '/system-settings', { kgraph: { enabled: false, retentionDays: null } });
  });

  async function library(tag: string, userOn: boolean) {
    const u = await login(`kgup-${tag}-${stamp}@example.test`);
    if (userOn) await patch(u.token, '/user-settings', { kgraph: { enabled: true } });
    const store = app.get(PrismaProcedureStore);
    const db = prisma.forUser({ userId: u.userId });
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const v = (procedure: string, id: string, number: number, state: string, sourceRun: string | null, elements: { id: string; label: string }[] = []) =>
      procedureVersionSchema.parse({ id, procedure, number, state, changeClass: 'initial', sourceRun, parent: null, createdAt: old, entry: 's1', steps: [{ id: 's1', kind: 'call', label: 'go', tool: 'click', ...(elements[0] ? { element: elements[0].id } : {}), args: {} }], sites: [{ id: 'site:example.test', domain: 'example.test' }], screens: elements.length ? [{ id: 'sc', site: 'site:example.test', label: 'x' }] : [], elements: elements.map((e) => ({ id: e.id, screen: 'sc', role: 'button', label: e.label, selectors: [`#${e.id.slice(3)}`] })) });
    // An active procedure with 8 retired versions, a run trace of its verified source run, and a recent run.
    const t1 = await db.task.create({ data: { userId: u.userId, name: 'Active', goal: 'g' } });
    const r1 = await db.run.create({ data: { userId: u.userId, taskId: t1.id, goal: 'g' } });
    await store.putProcedure({ id: `p-a-${tag}-${stamp}`, owner: u.userId, task: t1.id, name: 'Active', activeVersion: null, createdAt: old, updatedAt: old });
    for (let i = 1; i <= 8; i++) await store.putVersion(u.userId, v(`p-a-${tag}-${stamp}`, `v-r${i}-${tag}-${stamp}`, i, 'retired', null));
    const active = v(`p-a-${tag}-${stamp}`, `v-act-${tag}-${stamp}`, 9, 'active', r1.id, [{ id: 'el:go1', label: 'Go' }]);
    await store.putVersion(u.userId, active);
    await db.kgTrace.create({ data: { userId: u.userId, runId: r1.id, seq: 1, tool: 'click', family: 'browser', ok: true, outcome: 'ran' } });
    await db.kgRun.create({ data: { runId: r1.id, userId: u.userId, mode: 'reuse', procedureVersionId: active.id, outcome: 'replayed' } });
    // A stale procedure: not run for 90 days.
    const t2 = await db.task.create({ data: { userId: u.userId, name: 'Stale', goal: 'g' } });
    await store.putProcedure({ id: `p-s-${tag}-${stamp}`, owner: u.userId, task: t2.id, name: 'Stale', activeVersion: null, createdAt: old, updatedAt: old });
    await store.putVersion(u.userId, v(`p-s-${tag}-${stamp}`, `v-s-${tag}-${stamp}`, 1, 'candidate', null, [{ id: 'el:go2', label: 'Go' }]));
    // Nodes: the active element, its duplicate (same site, role, label, anchor), and an orphan element and site.
    const node = (id: string, type: string, key: string, props: object) => db.kgNode.create({ data: { id: `${id}-${tag}-${stamp}`, userId: u.userId, type, key, label: key, props: props as never } });
    await node('n1', 'Element', 'el:go1', { site: 'example.test', role: 'button', name: 'Go', anchor: null, selectors: ['#go1'] });
    await node('n2', 'Element', 'el:go2', { site: 'example.test', role: 'button', name: 'Go', anchor: null, selectors: ['#go2'] });
    await node('n3', 'Element', 'el:gone', { site: 'gone.example', role: 'link', name: 'Old', anchor: null, selectors: [] });
    await node('n4', 'Site', 'gone.example', {});
    return { u, active, t1 };
  }
  const snapshot = async (userId: string) => ({
    versions: await prisma.kgProcedureVersion.findMany({ where: { userId }, orderBy: { id: 'asc' }, select: { id: true, state: true } }),
    nodes: await prisma.kgNode.findMany({ where: { userId }, orderBy: { id: 'asc' }, select: { id: true, type: true, key: true, props: true } }),
    traces: await prisma.kgTrace.count({ where: { userId } }),
  });

  it('does each of the six actions, once, and changes nothing for a user whose switch is off', async () => {
    const on = await library('on', true);
    const off = await library('off', false);
    const offBefore = await snapshot(off.u.userId);
    const activeBefore = await prisma.kgProcedureVersion.findUniqueOrThrow({ where: { id: on.active.id } });

    const counts = await app.get(KgraphUpkeepService).runAll();
    expect(counts.traces).toBeGreaterThanOrEqual(1);

    const after = await snapshot(on.u.userId);
    // 1. traces of the verified run are gone
    expect(after.traces).toBe(0);
    // 2. 8 retired → the newest 5 kept; the active stays
    const states = after.versions.map((v) => v.state);
    expect(states.filter((s) => s === 'retired').length).toBe(6); // 5 kept + the stale candidate retired
    expect(after.versions.find((v) => v.id === on.active.id)?.state).toBe('active');
    // 3. the stale procedure's candidate is retired, not deleted
    expect(after.versions.find((v) => v.id.startsWith('v-s-'))?.state).toBe('retired');
    // 4. the orphan element and site are gone
    expect(after.nodes.some((n) => n.key === 'el:gone' || n.key === 'gone.example')).toBe(false);
    // 5. the duplicate element merged into the oldest, keeping both selectors
    const els = after.nodes.filter((n) => n.type === 'Element');
    expect(els).toHaveLength(1);
    expect((els[0]!.props as { selectors: string[] }).selectors).toEqual(['#go1', '#go2']);
    // 6. health per procedure
    expect(after.nodes.filter((n) => n.type === 'Health').length).toBe(2);
    // The active version's compiled bytes are equal.
    const activeAfter = await prisma.kgProcedureVersion.findUniqueOrThrow({ where: { id: on.active.id } });
    expect(activeAfter.graph).toEqual(activeBefore.graph);
    // Off: not a row touched.
    expect(await snapshot(off.u.userId)).toEqual(offBefore);
    // Idempotent: a second run changes nothing.
    await app.get(KgraphUpkeepService).runAll();
    expect(await snapshot(on.u.userId)).toEqual(after);
  });

  it('the admin action enqueues the job; nobody else may', async () => {
    const user = await login(`kgup-plain-${stamp}@example.test`);
    expect((await app.inject({ method: 'POST', url: '/api/kgraph/admin/upkeep', headers: { authorization: `Bearer ${user.token}` } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/kgraph/admin/upkeep', headers: { authorization: `Bearer ${admin.token}` } })).statusCode).toBe(202);
    expect(await prisma.job.count({ where: { type: 'kgraph.upkeep' } })).toBeGreaterThanOrEqual(1);
  });
});
