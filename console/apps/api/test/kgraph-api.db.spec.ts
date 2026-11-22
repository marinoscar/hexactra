// E46.19 (#793) against a real database: the Knowledge Graph's REST routes. Each route: its permission, another user's id answering 404, and
// the off state (reads answer with the stored data and `enabled: false`; restore and forget answer 409 KGRAPH_OFF; the admin settings answer
// whatever the switches). A marker test proves no typed value, secret, token or account address reaches any response.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSIONS_KEY } from '@marinoscar/platform-api/identity';
import { procedureVersionSchema, type ProcedureVersionInput } from '@marinoscar/hexactra-kgraph';

import { KgraphAdminController } from '../src/kgraph/kgraph-admin.controller';
import { KgraphReadController } from '../src/kgraph/kgraph-read.controller';
import { PrismaProcedureStore } from '../src/kgraph/prisma-procedure-store';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;
const workerMode = process.env.JOBS_WORKER_MODE;

// Markers: a card number (a typed value), a token, a secret's value and an account's address. None may appear in any response.
const CARD = '4111111111111111';
const TOKEN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWX123456';
const SECRET_VALUE = 'hunter2-correct-horse';
const EMAIL = `kg-marker-${stamp}@mail.example.test`;

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
async function login(name: string, role: 'contributor' | 'viewer' | 'admin' = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `kgapi-${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
type Res<T> = { statusCode: number; data: T; code?: string; body: string };
async function call<T = Record<string, unknown>>(s: Session | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<Res<T>> {
  const res = await app.inject({ method, url: `/api${url}`, headers: s ? { authorization: `Bearer ${s.token}` } : {}, ...(payload === undefined ? {} : { payload: payload as object }) });
  const body = res.body ? res.json<{ data?: T; code?: string; error?: { code?: string } }>() : undefined;
  return { statusCode: res.statusCode, data: body?.data as T, code: body?.code ?? body?.error?.code, body: res.body };
}

const at = new Date('2026-06-01T00:00:00.000Z').toISOString();
function versionInput(id: string, pid: string, n: number, state: 'active' | 'retired', parent: string | null): ProcedureVersionInput {
  return {
    id,
    procedure: pid,
    number: n,
    state,
    changeClass: n === 1 ? 'initial' : 'structural',
    sourceRun: null,
    parent,
    createdAt: at,
    entry: 's1',
    sites: [{ id: 'site1', domain: 'shop.example.test' }],
    accounts: [{ id: 'acc1', connectionId: 'conn-used', provider: 'google' }],
    secretRefs: [{ id: 'r1', kind: 'login', label: 'Shop login' }],
    parameters: [
      { id: 'p:pin', name: 'PIN', type: 'string', sensitive: true, required: true },
      { id: 'p:who', name: 'Customer', type: 'string', sensitive: false, required: true },
    ],
    outputs: [{ id: 'o1', name: 'paid', step: 's3', sensitive: false }],
    screens: [{ id: 'sc', site: 'site1', label: 'Checkout' }],
    elements: [{ id: 'el1', screen: 'sc', label: `Card ${CARD}`, selectors: ['#cc'] }],
    steps: [
      { id: 's1', kind: 'call', label: 'Open the shop', tool: 'navigate', sites: ['site1'], args: { url: { kind: 'literal', value: `https://shop.example.test/?token=${TOKEN}` } } },
      { id: 's2', kind: 'call', label: `Type ${CARD}`, tool: 'type_text', sites: ['site1'], element: 'el1', args: { text: { kind: 'literal', value: CARD }, who: { kind: 'parameter', parameter: 'p:who' }, pin: { kind: 'parameter', parameter: 'p:pin' } } },
      ...(n === 2 ? [{ id: 's2b', kind: 'call' as const, label: 'Sign in', tool: 'type_secret', sites: ['site1'], args: { secret: { kind: 'secret' as const, ref: 'r1', field: 'password' } } }] : []),
      { id: 's3', kind: 'judge', label: 'Is it paid?', inputs: { page: { kind: 'output', step: 's1' } }, output: [{ name: 'paid', type: 'boolean' }] },
      { id: 's4', kind: 'call', label: 'Send the receipt', tool: 'mail_send', commitClass: true, args: { body: { kind: 'judge', step: 's3', field: 'paid' } } },
    ],
    edges: [],
  };
}

describe('the Knowledge Graph API (#793)', () => {
  let admin: Session;
  let owner: Session;
  let other: Session;
  let viewer: Session;
  let taskId: string;
  let runId: string;
  const pid = `kgp-api-${stamp}`;
  const v1 = `kgv-api1-${stamp}`;
  const v2 = `kgv-api2-${stamp}`;

  beforeAll(async () => {
    admin = await login('admin', 'admin');
    owner = await login('owner');
    other = await login('other');
    viewer = await login('viewer', 'viewer');
    await call(admin, 'PATCH', '/system-settings', { kgraph: { enabled: false, auditEvery: 10, suspendAfterFailures: 3, retentionDays: null, pacing: 'human' } });
    taskId = (await call<{ id: string }>(owner, 'POST', '/tasks', { name: `Pay the bill ${TOKEN}`, goal: 'Pay the shop bill' })).data.id;
    const store = app.get(PrismaProcedureStore);
    await store.putProcedure({ id: pid, owner: owner.userId, task: taskId, name: 'Pay the bill', activeVersion: null, createdAt: at, updatedAt: at });
    await store.putVersion(owner.userId, procedureVersionSchema.parse(versionInput(v1, pid, 1, 'retired', null)));
    await store.putVersion(owner.userId, procedureVersionSchema.parse(versionInput(v2, pid, 2, 'active', v1)));
    await store.putProcedure({ id: pid, owner: owner.userId, task: taskId, name: 'Pay the bill', activeVersion: v2, createdAt: at, updatedAt: at });
    await store.recordEvidence(owner.userId, v2, 's1', 'success', at);
    // A connection the procedure uses, one it does not (with an added MCP tool), and a saved login a run signed in with.
    await prisma.connection.create({ data: { userId: owner.userId, provider: 'google', accountId: `acc-${stamp}`, accountEmail: EMAIL, label: 'Work mail', capabilities: ['mail'] } });
    const mcp = await prisma.connection.create({ data: { userId: owner.userId, provider: 'mcp', accountId: `mcp-${stamp}`, accountEmail: EMAIL, label: 'CRM', capabilities: [] } });
    await prisma.connectionMcpTool.create({ data: { connectionId: mcp.id, name: 'crm_lookup', title: 'Look up a customer', inputSchema: {}, hash: 'h'.repeat(64), mode: 'read', suggested: 'read' } });
    // A run that replayed s1, recovered s2, judged s3 and handed s4 to the agent. Its own memory holds a typed value: never shown.
    runId = (await prisma.forUser({ userId: owner.userId }).run.create({ data: { userId: owner.userId, taskId, goal: 'Pay the shop bill', transcript: { typed: SECRET_VALUE, kgraphReplay: { version: v2, done: ['s1', 's2', 's3'], intent: null, handedOver: true } }, usedSavedLogins: [{ provider: 'builtin', itemName: 'Bank login', origin: 'https://bank.example.test', at }] } })).id;
    await prisma.kgRun.create({ data: { runId, userId: owner.userId, mode: 'reuse', procedureVersionId: v2, outcome: 'fell_back' } });
    await prisma.kgNode.create({ data: { id: `kgn-fp-${stamp}`, userId: owner.userId, type: 'FingerprintProposal', key: `${v2}:s2:${runId}`, label: 'locate', props: { selector: '#cc-new' } } });
    await prisma.kgTrace.create({ data: { userId: owner.userId, runId, seq: 1, tool: 'type_text', family: 'browser', bindings: { text: { kind: 'literal', value: SECRET_VALUE } }, post: {}, ok: true, outcome: 'ran' } });
  });
  afterAll(async () => {
    await call(admin, 'PATCH', '/system-settings', { kgraph: { enabled: false, auditEvery: 10 } });
  });

  const reads = () => [
    `/kgraph/procedures`,
    `/kgraph/procedures?taskId=${taskId}&state=active&q=bill`,
    `/kgraph/procedures/${pid}`,
    `/kgraph/procedures/${pid}/versions`,
    `/kgraph/procedures/${pid}/versions/2`,
    `/kgraph/procedures/${pid}/versions/2/diff`,
    `/kgraph/procedures/${pid}/versions/2/diff?against=1`,
    `/kgraph/graph`,
    `/kgraph/graph?taskId=${taskId}&site=shop.example.test&types=Procedure,Step,Site`,
    `/kgraph/runs/${runId}`,
  ];

  it('declares kgraph:read on every read route and kgraph:admin on the settings', () => {
    const perms = (proto: object, m: string) => Reflect.getMetadata(PERMISSIONS_KEY, (proto as Record<string, object>)[m]!) as string[] | undefined;
    for (const m of ['procedures', 'procedure', 'versions', 'version', 'diff', 'graph', 'run']) expect([m, perms(KgraphReadController.prototype, m)]).toEqual([m, ['kgraph:read']]);
    for (const m of ['get', 'put']) expect(perms(KgraphAdminController.prototype, m)).toEqual(['kgraph:admin']);
  });

  it('refuses a caller without a session, and the admin settings to anyone but an administrator', async () => {
    for (const url of reads()) expect([url, (await call(null, 'GET', url)).statusCode]).toEqual([url, 401]);
    expect((await call(null, 'GET', '/admin/kgraph/settings')).statusCode).toBe(401);
    for (const s of [owner, viewer]) {
      expect((await call(s, 'GET', '/admin/kgraph/settings')).statusCode).toBe(403);
      expect((await call(s, 'PUT', '/admin/kgraph/settings', { enabled: true })).statusCode).toBe(403);
    }
    // A viewer reads (kgraph:read) but cannot restore or forget (kgraph:write).
    expect((await call(viewer, 'GET', '/kgraph/procedures')).statusCode).toBe(200);
    expect((await call(viewer, 'POST', `/kgraph/procedures/${pid}/forget`)).statusCode).toBe(403);
  });

  it("answers another user's procedure, version and run with 404, and lists nothing of theirs", async () => {
    for (const url of reads().filter((u) => u.includes(pid) || u.includes(runId))) {
      const r = await call(other, 'GET', url);
      expect([url, r.statusCode]).toEqual([url, 404]);
    }
    expect((await call(other, 'GET', `/kgraph/runs/${runId}`)).code).toBe('KGRAPH_RUN_NOT_FOUND');
    expect((await call(other, 'GET', `/kgraph/procedures/${pid}`)).code).toBe('KGRAPH_PROCEDURE_NOT_FOUND');
    expect((await call<{ procedures: unknown[] }>(other, 'GET', '/kgraph/procedures')).data.procedures).toEqual([]);
    const g = await call<{ nodes: { id: string }[] }>(other, 'GET', '/kgraph/graph');
    expect(g.data.nodes.some((n) => n.id.startsWith('procedure:') || n.id.includes('conn'))).toBe(false);
    for (const [method, url] of [['POST', `/kgraph/procedures/${pid}/forget`], ['POST', `/kgraph/procedures/${pid}/restore`]] as const) expect((await call(other, method, url, url.endsWith('restore') ? { versionId: v1 } : undefined)).statusCode).toBe(404);
    expect((await call(owner, 'GET', `/kgraph/procedures/${pid}/versions/9`)).code).toBe('KGRAPH_VERSION_NOT_FOUND');
  });

  it('with a switch off, reads show the stored data with enabled false and restore and forget answer 409 KGRAPH_OFF', async () => {
    for (const url of reads()) {
      const r = await call<{ enabled: boolean }>(owner, 'GET', url);
      expect([url, r.statusCode, r.data.enabled]).toEqual([url, 200, false]);
    }
    expect((await call<{ procedures: unknown[] }>(owner, 'GET', '/kgraph/procedures')).data.procedures).toHaveLength(1);
    for (const r of [await call(owner, 'POST', `/kgraph/procedures/${pid}/forget`), await call(owner, 'POST', `/kgraph/procedures/${pid}/restore`, { versionId: v1 })]) expect([r.statusCode, r.code]).toEqual([409, 'KGRAPH_OFF']);
    expect((await app.get(PrismaProcedureStore).getVersion(owner.userId, v2))!.state).toBe('active');
    // The admin settings answer whatever the switches.
    expect((await call(admin, 'GET', '/admin/kgraph/settings')).statusCode).toBe(200);
  });

  it('reads and writes the deployment settings through the system settings, with an audit of keys only', async () => {
    expect((await call(admin, 'GET', '/admin/kgraph/settings')).data).toEqual({ enabled: false, auditEvery: 10, suspendAfterFailures: 3, retentionDays: null, pacing: 'human' });
    const put = await call(admin, 'PUT', '/admin/kgraph/settings', { auditEvery: 5 });
    expect([put.statusCode, put.data]).toEqual([200, { enabled: false, auditEvery: 5, suspendAfterFailures: 3, retentionDays: null, pacing: 'human' }]);
    expect((await call<{ kgraph: { auditEvery: number } }>(admin, 'GET', '/system-settings')).data.kgraph.auditEvery).toBe(5);
    expect((await call(admin, 'PUT', '/admin/kgraph/settings', { enabled: 'yes' })).statusCode).toBe(400);
    expect((await call(admin, 'PUT', '/admin/kgraph/settings', { unknown: 1 })).statusCode).toBe(400);
    const audit = await prisma.auditEvent.findFirst({ where: { actorUserId: admin.userId, action: 'kgraph.settings.changed' }, orderBy: { createdAt: 'desc' } });
    expect(audit?.meta).toEqual({ changed: ['auditEvery'], enabled: false });
    expect((await call(admin, 'PUT', '/admin/kgraph/settings', { enabled: true, pacing: 'fast' })).data).toMatchObject({ enabled: true, pacing: 'fast' });
    expect((await call(owner, 'PATCH', '/user-settings', { kgraph: { enabled: true } })).statusCode).toBe(200);
    expect((await call<{ enabled: boolean }>(owner, 'GET', '/kgraph/procedures')).data.enabled).toBe(true);
  });

  it('lists procedures with state, health and the ledger summary, and filters them', async () => {
    const list = (await call<{ procedures: Record<string, unknown>[] }>(owner, 'GET', '/kgraph/procedures')).data.procedures;
    expect(list).toEqual([expect.objectContaining({ id: pid, taskId, name: 'Pay the bill', versionId: v2, versionNumber: 2, state: 'active', health: 'healthy', steps: 5, ledger: { runs: 0, procedureRuns: 0, cleanReplayRate: null } })]);
    expect((await call<{ procedures: unknown[] }>(owner, 'GET', '/kgraph/procedures?state=retired')).data.procedures).toEqual([]);
    expect((await call<{ procedures: unknown[] }>(owner, 'GET', '/kgraph/procedures?q=nothing-like-it')).data.procedures).toEqual([]);
    expect((await call(owner, 'GET', '/kgraph/procedures?state=sleeping')).statusCode).toBe(400);
  });

  it('shows a procedure as an ordered step list with arguments by source, its versions and a readable diff', async () => {
    const p = (await call<{ activeVersion: { steps: { id: string; tool: string | null; usesAi: boolean; commitClass: boolean; args: { name: string; source: string; detail: string | null }[]; target: string | null; health: string }[]; parameters: unknown[]; savedLogins: unknown[] }; versions: number }>(owner, 'GET', `/kgraph/procedures/${pid}`)).data;
    expect(p.versions).toBe(2);
    expect(p.activeVersion.steps.map((s) => [s.id, s.tool, s.usesAi, s.commitClass])).toEqual([
      ['s1', 'navigate', false, false],
      ['s2', 'type_text', false, false],
      ['s2b', 'type_secret', false, false],
      ['s3', null, true, false],
      ['s4', 'mail_send', false, true],
    ]);
    expect(p.activeVersion.steps[0]!.health).toBe('healthy');
    expect(p.activeVersion.steps[2]!.args).toEqual([{ name: 'secret', source: 'secret', detail: 'login "Shop login"' }]);
    expect(p.activeVersion.steps[1]!.args.find((a) => a.name === 'pin')).toEqual({ name: 'pin', source: 'parameter', detail: 'PIN' });
    expect(p.activeVersion.parameters).toContainEqual({ name: 'PIN', type: 'string', sensitive: true, required: true });
    expect(p.activeVersion.savedLogins).toEqual([{ kind: 'login', label: 'Shop login' }]);

    const versions = (await call<{ versions: { number: number; state: string }[] }>(owner, 'GET', `/kgraph/procedures/${pid}/versions`)).data.versions;
    expect(versions.map((v) => [v.number, v.state])).toEqual([[2, 'active'], [1, 'retired']]);
    expect((await call<{ number: number; state: string }>(owner, 'GET', `/kgraph/procedures/${pid}/versions/1`)).data).toMatchObject({ number: 1, state: 'retired' });
    const diff = (await call<{ from: number; to: number; changes: { change: string; text: string }[] }>(owner, 'GET', `/kgraph/procedures/${pid}/versions/2/diff`)).data;
    expect([diff.from, diff.to]).toEqual([1, 2]);
    expect(diff.changes.find((c) => c.change === 'inserted')?.text).toBe('"Sign in" was added.');
    expect((await call<{ from: number | null }>(owner, 'GET', `/kgraph/procedures/${pid}/versions/1/diff`)).data.from).toBeNull();
  });

  it('builds the map: procedures, steps and capabilities, with unused accounts, tools and saved logins, filters and clusters', async () => {
    const g = (await call<{ nodes: { id: string; type: string; label: string; unused: boolean; cluster: string | null }[]; edges: { type: string; from: string; to: string }[]; clusters: { id: string; kind: string }[]; collapsed: boolean; nodeLimit: number }>(owner, 'GET', '/kgraph/graph')).data;
    const node = (pred: (n: (typeof g.nodes)[number]) => boolean) => g.nodes.find(pred);
    expect(node((n) => n.id === `procedure:${pid}`)).toBeDefined();
    expect(node((n) => n.id === 'account:conn-used')?.unused).toBe(false);
    expect(node((n) => n.type === 'Account' && n.label === 'Work mail (google)')?.unused).toBe(true);
    expect(node((n) => n.type === 'Tool' && n.label === 'Look up a customer')).toMatchObject({ unused: true });
    expect(node((n) => n.id === 'secret:login:bank login')?.unused).toBe(true);
    expect(node((n) => n.id === 'secret:login:shop login')?.unused).toBe(false);
    expect(g.edges).toContainEqual({ type: 'uses', from: `step:${pid}:s2b`, to: 'secret:login:shop login' });
    expect(g.clusters).toContainEqual(expect.objectContaining({ id: 'site:shop.example.test', kind: 'site' }));
    expect([g.collapsed, g.nodeLimit]).toEqual([false, 2000]);

    const narrow = (await call<{ nodes: { type: string; unused: boolean }[] }>(owner, 'GET', `/kgraph/graph?taskId=${taskId}&types=Procedure,Site`)).data;
    expect(new Set(narrow.nodes.map((n) => n.type))).toEqual(new Set(['Procedure', 'Site']));
    expect(narrow.nodes.some((n) => n.unused)).toBe(false);
    expect((await call<{ nodes: unknown[] }>(owner, 'GET', '/kgraph/graph?site=elsewhere.example')).data.nodes).toEqual([]);
    expect((await call(owner, 'GET', '/kgraph/graph?types=Nothing')).statusCode).toBe(400);
  });

  it('says how each step of a run ran', async () => {
    const r = (await call<{ mode: string; outcome: string; versionNumber: number; procedureId: string; steps: { id: string; how: string }[] }>(owner, 'GET', `/kgraph/runs/${runId}`)).data;
    expect(r).toMatchObject({ mode: 'reuse', outcome: 'fell_back', versionNumber: 2, procedureId: pid });
    expect(r.steps.map((s) => [s.id, s.how])).toEqual([
      ['s1', 'replayed'],
      ['s2', 'recovered'],
      ['s2b', 'agent'],
      ['s3', 'judged'],
      ['s4', 'agent'],
    ]);
    // A run without the Knowledge Graph: mode off, no steps.
    const plain = (await prisma.forUser({ userId: owner.userId }).run.create({ data: { userId: owner.userId, taskId, goal: 'x' } })).id;
    expect((await call(owner, 'GET', `/kgraph/runs/${plain}`)).data).toMatchObject({ mode: 'off', steps: [], ledger: null });
  });

  it('never puts a typed value, a secret, a token or an account address in any response', async () => {
    const urls = [...reads(), '/kgraph/status', '/kgraph/reviews', `/kgraph/ledger?taskId=${taskId}`, '/kgraph/summary', `/tasks/${taskId}/kgraph`];
    for (const url of urls) {
      const r = await call(owner, 'GET', url);
      expect([url, r.statusCode]).toEqual([url, 200]);
      for (const marker of [CARD, TOKEN, SECRET_VALUE, EMAIL]) expect([url, marker, r.body.includes(marker)]).toEqual([url, marker, false]);
    }
    expect((await call(admin, 'GET', '/admin/kgraph/settings')).body).not.toContain(TOKEN);
  });

  it('forgets a procedure once the switches are on; audit events carry ids and counts only', async () => {
    const r = await call<{ retired: number }>(owner, 'POST', `/kgraph/procedures/${pid}/forget`);
    expect([r.statusCode, r.code, r.data?.retired]).toEqual([200, undefined, 1]);
    const audit = await prisma.auditEvent.findFirst({ where: { actorUserId: owner.userId, action: 'kgraph.procedure.forgotten' } });
    expect(audit?.meta).toEqual({ procedureId: pid, retired: 1 });
  });
});
