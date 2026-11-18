// Connected AI apps (E33.6, #464), against a real database: who started each
// run (origin and client, set from the request's credential, never from a
// body or a network header), the per-app limits with their typed refusals
// (no run row on a refusal), the runs filters, the "AI apps" routes and their
// RBAC, the preflight, and the notices of a new connection or a step-up.
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { OAuthServerSettingsReader, PatService } from '@marinoscar/platform-api/identity';
import { createOAuthTestClient, mintOAuthTestToken, type OAuthTestClient } from '@marinoscar/platform-api/identity/testing';
import { JobsService } from '@marinoscar/platform-api/jobs';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { AppGrantNotifyHandler, ConnectedAppsGrantListener } from '../src/connected-apps/connected-apps.jobs';
import { APP_CONNECTED_EVENT, APP_FIRST_RUN_EVENT, APP_SCOPE_ADDED_EVENT } from '../src/connected-apps/connected-apps.notifications';
import { ConnectedAppsPreflight } from '../src/connected-apps/connected-apps.preflight';
import { MCP_CLIENT_HEADER } from '../src/connected-apps/request-client';
import { FabricClient } from '../src/fabric/fabric.client';
import { createApp } from '../src/main';
import { MCP_SCOPES } from '../src/mcp/mcp.scopes';
import { PrismaService } from '../src/prisma/prisma.service';
import { GoalRunnerService } from '../src/runner/goal-runner.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
let appUrl: string;
let admin: string;
let adminId: string;
let client: OAuthTestClient;
const stamp = randomUUID().slice(0, 8);
const HOST = `apps-${stamp}.example.test`;
const workerMode = process.env.JOBS_WORKER_MODE;
const DEFAULTS = MCP_SCOPES.filter((s) => s.default).map((s) => s.id);

async function login(email: string, role: 'contributor' | 'viewer' | 'admin' = 'contributor') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const id = (await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id;
  return { token, id };
}

async function setOAuth(patch: Record<string, unknown>) {
  await app.get(SystemSettingsService).patchSettings({ oauthServer: patch } as never, adminId);
  app.get(OAuthServerSettingsReader).invalidate();
  app.get(ConnectedAppsPreflight).invalidate();
}

async function mint(userId: string, scopes: readonly string[] = DEFAULTS): Promise<string> {
  await prisma.oAuthGrant.updateMany({ where: { userId, clientId: client.id, revokedAt: null }, data: { revokedAt: new Date() } });
  return (await mintOAuthTestToken(prisma as never, { userId, resourceId: 'mcp', scopes, appUrl, client: { id: client.id } })).token;
}

async function rpc(authorization: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/mcp',
    headers: { authorization, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...headers },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

async function runGoal(authorization: string, goal: string, extra: Record<string, unknown> = {}, meta?: Record<string, unknown>) {
  const r = await rpc(authorization, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_goal', arguments: { goal, wait_s: 0, ...extra }, ...(meta ? { _meta: meta } : {}) } });
  expect(r.status).toBe(200);
  return r.json.result as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> };
}

const api = (token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url: `/api${url}`, headers: { authorization: `Bearer ${token}`, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });

const runsOf = (userId: string) => prisma.run.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });

beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
  prisma = app.get(PrismaService);
  appUrl = app.get(ConfigService).get<string>('appUrl')!.replace(/\/+$/, '');
  ({ token: admin, id: adminId } = await login(`apps-admin-${stamp}@example.test`, 'admin'));
  client = await createOAuthTestClient(prisma as never, { name: 'Scripted assistant', redirectUris: [`https://${HOST}/callback`], host: HOST, tokenEndpointAuthMethod: 'none' });
  await setOAuth({ enabled: true, allowedClientHosts: [HOST], allowAnyClientHost: false });
}, 120_000);

afterAll(async () => {
  try {
    if (app) await setOAuth({ enabled: false, allowedClientHosts: [] });
  } finally {
    await prisma?.oAuthClient.deleteMany({ where: { id: client?.id } });
    await app?.close();
  }
});

describe('who started a run (#464)', () => {
  it('an OAuth app over MCP: origin mcp, its client id, host name and grant; the payload says verified', async () => {
    const u = await login(`apps-oauth-${stamp}@example.test`);
    const token = await mint(u.id);
    const out = await runGoal(`Bearer ${token}`, 'Find the opening hours of the library');
    expect(out.isError).toBeFalsy();
    const [run] = await runsOf(u.id);
    const grant = await prisma.oAuthGrant.findFirstOrThrow({ where: { userId: u.id, clientId: client.id, revokedAt: null } });
    expect(run).toMatchObject({ origin: 'mcp', clientId: client.id, clientName: HOST, grantId: grant.id });
    const view = await api(u.token, 'GET', `/runs/${run!.id}`);
    expect(view.json().data).toMatchObject({ origin: 'mcp', client: { id: client.id, name: HOST, verified: true } });
    expect(view.json().data).not.toHaveProperty('grantId');
    expect(view.json().data).not.toHaveProperty('appLimits');
    // The run records the limits that applied (the defaults) and the first run is announced (off by default: a record, not a toast).
    expect(run!.appLimits).toMatchObject({ clientId: client.id, maxConcurrentRuns: 2, dailyRunLimit: 50, confirmPurchases: true, allowedDomains: [] });
  });

  it('a personal access token over MCP: origin mcp, no client id, the MCP clientInfo name, unverified', async () => {
    const u = await login(`apps-pat-${stamp}@example.test`);
    const pat = await app.get(PatService).createToken(u.id, { name: 'agent', durationValue: 1, durationUnit: 'days' } as never);
    await runGoal(`Bearer ${pat.token}`, 'Check the weather', {}, { 'io.modelcontextprotocol/clientInfo': { name: 'Hermes Agent', version: '1.0' } });
    const [run] = await runsOf(u.id);
    expect(run).toMatchObject({ origin: 'mcp', clientId: null, clientName: 'Hermes Agent', grantId: null, appLimits: null });
    const view = await api(u.token, 'GET', `/runs/${run!.id}`);
    expect(view.json().data.client).toEqual({ id: null, name: 'Hermes Agent', verified: false });
  });

  it('REST callers get their origin from the credential and User-Agent; a body or a network header never sets the client', async () => {
    const u = await login(`apps-rest-${stamp}@example.test`);
    const web = await api(u.token, 'POST', '/runs', { goal: 'From the console', clientName: 'ChatGPT', clientId: client.id, origin: 'mcp' });
    expect(web.statusCode).toBe(201);
    expect(web.json().data).toMatchObject({ origin: 'web', client: null });
    // The marker header of the MCP endpoint's in-process calls is ignored when it comes over the network.
    const spoof = await api(u.token, 'POST', '/runs', { goal: 'Spoofed' }, { [MCP_CLIENT_HEADER]: 'ChatGPT' });
    expect(spoof.json().data).toMatchObject({ origin: 'web', client: null });
    const pat = await app.get(PatService).createToken(u.id, { name: 'cli', durationValue: 1, durationUnit: 'days' } as never);
    const cli = await api(pat.token, 'POST', '/runs', { goal: 'From the CLI' }, { 'user-agent': 'hexactra/1.43.0 (node v24.0.0)' });
    expect(cli.json().data.origin).toBe('cli');
    const sdk = await api(pat.token, 'POST', '/runs', { goal: 'From a script' }, { 'user-agent': 'python-httpx/0.27' });
    expect(sdk.json().data.origin).toBe('api');
    const rows = await runsOf(u.id);
    expect(rows.map((r) => [r.origin, r.clientId, r.clientName])).toEqual([
      ['web', null, null],
      ['web', null, null],
      ['cli', null, null],
      ['api', null, null],
    ]);
  });

  it('GET /runs filters by origin and clientId; list rows carry no transcript or client columns', async () => {
    const u = await login(`apps-filter-${stamp}@example.test`);
    const token = await mint(u.id);
    await runGoal(`Bearer ${token}`, 'By the app');
    await api(u.token, 'POST', '/runs', { goal: 'By hand' });
    const byApp = await api(u.token, 'GET', `/runs?envelope=1&clientId=${client.id}`);
    expect(byApp.json().data.items.map((r: { goal: string }) => r.goal)).toEqual(['By the app']);
    const item = byApp.json().data.items[0];
    expect(item.client).toEqual({ id: client.id, name: HOST, verified: true });
    for (const k of ['transcript', 'policySnapshot', 'clientId', 'clientName', 'grantId', 'appLimits']) expect(item).not.toHaveProperty(k);
    const web = await api(u.token, 'GET', '/runs?envelope=1&origin=web');
    expect(web.json().data.items.map((r: { goal: string }) => r.goal)).toEqual(['By hand']);
    const both = await api(u.token, 'GET', '/runs?origin=web,mcp');
    expect(both.json().data).toHaveLength(2);
    expect((await api(u.token, 'GET', '/runs?origin=nowhere')).statusCode).toBe(400);
    const counts = await api(u.token, 'GET', `/runs/counts?clientId=${client.id}`);
    expect(counts.json().data.total).toBe(1);
  });
});

describe('per-app limits (#464)', () => {
  async function setup(name: string, settings: Record<string, unknown> = {}) {
    const u = await login(`apps-lim-${name}-${stamp}@example.test`);
    const token = await mint(u.id);
    if (Object.keys(settings).length) {
      const r = await api(u.token, 'PATCH', `/connected-apps/${client.id}/settings`, settings);
      expect(r.statusCode).toBe(200);
    }
    return { u, token, call: (goal: string, extra: Record<string, unknown> = {}) => runGoal(`Bearer ${token}`, goal, extra) };
  }
  // A tool with an output schema carries the code in its text (`withoutSchemaBreakingError`).
  const codeOf = (r: { structuredContent?: Record<string, unknown>; content: Array<{ text: string }> }) => r.structuredContent?.code ?? /\[([A-Z_]+)\]$/.exec(r.content[0]?.text ?? '')?.[1];

  it('paused: refuses new runs with APP_PAUSED and no row, and leaves a live run running', async () => {
    const { u, call } = await setup('paused');
    await call('Before the pause');
    const before = await runsOf(u.id);
    await api(u.token, 'PATCH', `/connected-apps/${client.id}/settings`, { paused: true });
    const refused = await call('After the pause');
    expect(refused.isError).toBe(true);
    expect(codeOf(refused)).toBe('APP_PAUSED');
    expect(refused.content[0]!.text).toMatch(/paused this app/);
    const after = await runsOf(u.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe(before[0]!.status);
    // A person in the console is not the app: their runs are not limited.
    expect((await api(u.token, 'POST', '/runs', { goal: 'By hand' })).statusCode).toBe(201);
    await api(u.token, 'PATCH', `/connected-apps/${client.id}/settings`, { paused: false });
    expect((await call('Resumed')).isError).toBeFalsy();
  });

  it('maxConcurrentRuns: at the limit the next is APP_RUN_LIMIT, no row', async () => {
    const { u, call } = await setup('conc', { maxConcurrentRuns: 2 });
    expect((await call('one')).isError).toBeFalsy();
    expect((await call('two')).isError).toBeFalsy();
    const third = await call('three');
    expect(codeOf(third)).toBe('APP_RUN_LIMIT');
    expect(third.content[0]!.text).toMatch(/2 runs working at once/);
    expect(await runsOf(u.id)).toHaveLength(2);
    // One finishes: room again.
    const [first] = await runsOf(u.id);
    await prisma.run.update({ where: { id: first!.id }, data: { status: 'succeeded', finishedAt: new Date() } });
    expect((await call('three again')).isError).toBeFalsy();
  });

  it('dailyRunLimit: the limit-th run of the day passes, the next is APP_RUN_LIMIT', async () => {
    const { u, call } = await setup('daily', { dailyRunLimit: 2, maxConcurrentRuns: 5 });
    expect((await call('a')).isError).toBeFalsy();
    expect((await call('b')).isError).toBeFalsy();
    const c = await call('c');
    expect(codeOf(c)).toBe('APP_RUN_LIMIT');
    expect(c.content[0]!.text).toMatch(/daily limit of 2 runs/);
    expect(await runsOf(u.id)).toHaveLength(2);
  });

  it('dailyCostLimitUsd: under the limit passes, at it APP_COST_LIMIT', async () => {
    const { u, call } = await setup('cost', { dailyCostLimitUsd: 1, maxConcurrentRuns: 5 });
    await call('spends');
    const [run] = await runsOf(u.id);
    await prisma.run.update({ where: { id: run!.id }, data: { costUsd: 0.99 } });
    expect((await call('still under')).isError).toBeFalsy();
    await prisma.run.update({ where: { id: run!.id }, data: { costUsd: 1 } });
    const over = await call('over');
    expect(codeOf(over)).toBe('APP_COST_LIMIT');
    expect(over.content[0]!.text).toMatch(/\$1\.00/);
    expect(await runsOf(u.id)).toHaveLength(2);
  });

  it('allowed policies: a policy outside the list is APP_POLICY_NOT_ALLOWED; without one the app policy applies', async () => {
    const { u, call } = await setup('policy', { allowedPolicyIds: ['builtin:economy', 'builtin:balanced'], policyId: 'builtin:economy' });
    const refused = await call('thorough', { policy_id: 'builtin:thorough' });
    expect(codeOf(refused)).toBe('APP_POLICY_NOT_ALLOWED');
    expect(await runsOf(u.id)).toHaveLength(0);
    await call('balanced', { policy_id: 'builtin:balanced' });
    await call('default');
    const rows = await runsOf(u.id);
    expect(rows.map((r) => r.policyRef)).toEqual(['builtin:balanced', 'builtin:economy']);
    // A default outside the allowed list is refused at save time.
    const bad = await api(u.token, 'PATCH', `/connected-apps/${client.id}/settings`, { policyId: 'builtin:thorough' });
    expect(bad.statusCode).toBe(400);
  });

  it('allowed sites intersect the task: lists that cannot meet are APP_DOMAIN_NOT_ALLOWED; the snapshot records the limits', async () => {
    const { u, token } = await setup('sites', { allowedDomains: ['shop.example.test'] });
    const task = await api(u.token, 'POST', '/tasks', { name: 'Elsewhere', goal: 'Buy it', allowedDomains: ['other.example.test'] });
    expect(task.statusCode).toBe(201);
    const refused = await rpc(`Bearer ${token}`, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task_run', arguments: { task_id: task.json().data.id, wait_s: 0 } } });
    expect(refused.json.result.content[0].text).toMatch(/\[APP_DOMAIN_NOT_ALLOWED\]$/);
    expect(await runsOf(u.id)).toHaveLength(0);

    const ok = await api(u.token, 'POST', '/tasks', { name: 'Shop', goal: 'Buy it', allowedDomains: ['shop.example.test'], confirmRiskyActions: false });
    const started = await rpc(`Bearer ${token}`, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task_run', arguments: { task_id: ok.json().data.id, wait_s: 0 } } });
    expect(started.json.result.isError).toBeFalsy();
    const [run] = await runsOf(u.id);
    // The first advance snapshots the policy with the app's limits: never wider than the task, purchases confirmed.
    const runner = app.get(GoalRunnerService) as unknown as { policySnapshot: (db: unknown, run: unknown, memory: unknown) => Promise<{ appLimits?: Record<string, unknown> }> };
    const full = await prisma.run.findUniqueOrThrow({ where: { id: run!.id }, include: { task: true } });
    const snap = await runner.policySnapshot(prisma.forUser({ userId: u.id }), full, { log: [], chunks: 0 });
    expect(snap.appLimits).toMatchObject({ clientId: client.id, allowedDomains: ['shop.example.test'], confirmPurchases: true });
  });

  it("browser sessions: the app's sites are checked as well as the session's own, and the session is attributed", async () => {
    const u = await login(`apps-lim-session-${stamp}@example.test`);
    const token = await mint(u.id, [...DEFAULTS, 'browser:drive']);
    await api(u.token, 'PATCH', `/connected-apps/${client.id}/settings`, { allowedDomains: ['shop.example.test'] });
    const spy = jest.spyOn(app.get(FabricClient), 'request').mockImplementation((async (method: string, path: string) => {
      if (method === 'POST' && path === '/v1/sessions') return { id: randomUUID() };
      if (method === 'POST' && path.endsWith('/actions')) return { id: randomUUID(), state: 'succeeded', result: { url: 'https://shop.example.test/' } };
      if (method === 'DELETE') return undefined;
      throw new Error(`unexpected ${method} ${path}`);
    }) as never);
    try {
      const call = (name: string, args: Record<string, unknown>) => rpc(`Bearer ${token}`, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
      const opened = await call('browser_open', { goal: 'Shop' });
      expect(opened.json.result.isError).toBeFalsy();
      const [run] = await runsOf(u.id);
      expect(run).toMatchObject({ trigger: 'external', origin: 'mcp', clientId: client.id, clientName: HOST });
      expect((await call('browser_navigate', { session_id: run!.id, url: 'https://shop.example.test/cart' })).json.result.isError).toBeFalsy();
      const refused = await call('browser_navigate', { session_id: run!.id, url: 'https://elsewhere.example.test/' });
      expect(refused.json.result.isError).toBe(true);
      expect(JSON.stringify(refused.json.result)).toContain('APP_DOMAIN_NOT_ALLOWED');
    } finally {
      spy.mockRestore();
    }
  });

  it('PATCH validates and respects the deployment ceilings; a limit is per user', async () => {
    const { u } = await setup('patch');
    expect((await api(u.token, 'PATCH', `/connected-apps/${client.id}/settings`, { maxConcurrentRuns: 0 })).statusCode).toBe(400);
    expect((await api(u.token, 'PATCH', `/connected-apps/${client.id}/settings`, { dailyRunLimit: 999 })).statusCode).toBe(400);
    expect((await api(u.token, 'PATCH', `/connected-apps/${client.id}/settings`, { unknown: true })).statusCode).toBe(400);
    expect((await api(u.token, 'PATCH', `/connected-apps/${client.id}/settings`, { allowedDomains: ['not a domain!'] })).statusCode).toBe(400);
    const ok = await api(u.token, 'PATCH', `/connected-apps/${client.id}/settings`, { dailyRunLimit: 200, dailyCostLimitUsd: 2.5, allowedDomains: ['Example.test'] });
    expect(ok.json().data).toMatchObject({ dailyRunLimit: 200, dailyCostLimitUsd: 2.5, allowedDomains: ['example.test'] });
    // An app the user never connected.
    expect((await api(u.token, 'PATCH', `/connected-apps/${randomUUID()}/settings`, { paused: true })).statusCode).toBe(404);
  });
});

describe('the AI apps routes (#464)', () => {
  it('lists the caller\'s apps with scopes, limits and usage; another user sees nothing of them', async () => {
    const owner = await login(`apps-list-${stamp}@example.test`);
    const other = await login(`apps-other-${stamp}@example.test`);
    const token = await mint(owner.id, [...DEFAULTS, 'browser:drive']);
    await runGoal(`Bearer ${token}`, 'Counted');
    const list = await api(owner.token, 'GET', '/connected-apps');
    expect(list.statusCode).toBe(200);
    const [entry] = list.json().data;
    expect(entry).toMatchObject({ clientId: client.id, name: HOST, verified: true, removed: false, usage: { runs30d: 1, liveRuns: 1, runsToday: 1 } });
    expect(entry.scopes.map((s: { label: string }) => s.label)).toEqual(expect.arrayContaining(['Delegate', 'Inbox', 'Drive browser']));
    expect(entry.scopes.find((s: { id: string }) => s.id === 'browser:drive').risk).toBe('elevated');
    expect(entry.grantId).toBeTruthy();

    expect((await api(other.token, 'GET', '/connected-apps')).json().data).toEqual([]);
    expect((await api(other.token, 'GET', `/connected-apps/${client.id}`)).statusCode).toBe(404);
    expect((await api(other.token, 'PATCH', `/connected-apps/${client.id}/settings`, { paused: true })).statusCode).toBe(404);
    expect(await prisma.connectedAppSettings.count({ where: { userId: other.id } })).toBe(0);

    // Disconnect is the platform's grant route: the app is gone from the list; its run keeps its name.
    expect((await api(owner.token, 'DELETE', `/oauth/grants/${entry.grantId}`)).statusCode).toBe(204);
    expect((await api(owner.token, 'GET', '/connected-apps')).json().data).toEqual([]);
    const detail = await api(owner.token, 'GET', `/connected-apps/${client.id}`);
    expect(detail.json().data).toMatchObject({ grantId: null, name: HOST, usage: { runs30d: 1 } });
  });

  it('RBAC: a viewer has no connected_apps permission', async () => {
    const viewer = await login(`apps-viewer-${stamp}@example.test`, 'viewer');
    expect((await api(viewer.token, 'GET', '/connected-apps')).statusCode).toBe(403);
    expect((await api(viewer.token, 'GET', '/connected-apps/preflight')).statusCode).toBe(403);
    expect((await api(viewer.token, 'PATCH', `/connected-apps/${client.id}/settings`, { paused: true })).statusCode).toBe(403);
  });

  it('the preflight: OAuth on or off, as an administrator and as a member', async () => {
    const member = await login(`apps-pre-${stamp}@example.test`);
    const on = (await api(member.token, 'GET', '/connected-apps/preflight')).json().data;
    expect(on.mcpUrl).toBe(`${appUrl}/api/mcp`);
    expect(on.admin).toBe(false);
    expect(on.checks.find((c: { id: string }) => c.id === 'oauth_enabled').status).toBe('pass');
    expect(on.clients.find((c: { id: string }) => c.id === 'chatgpt')).toMatchObject({ allowed: false, hosts: ['chatgpt.com'] });

    await setOAuth({ enabled: false });
    try {
      const off = (await api(member.token, 'GET', '/connected-apps/preflight')).json().data;
      const row = off.checks.find((c: { id: string }) => c.id === 'oauth_enabled');
      expect(row).toMatchObject({ status: 'fail', fix: { who: 'admin', path: null } });
      expect(row.fix.text).toMatch(/^Ask your administrator/);
      expect(off.ready).toBe(false);
      const asAdmin = (await api(admin, 'GET', '/connected-apps/preflight')).json().data;
      expect(asAdmin.admin).toBe(true);
      expect(asAdmin.checks[0].fix).toMatchObject({ who: 'admin', path: '/admin/settings/oauth-clients' });
    } finally {
      await setOAuth({ enabled: true });
    }
  });
});

describe('notifications (#464)', () => {
  it('the grant event only enqueues a job; the job sends app.connected once with the scopes, and app.scope_added on a high-risk step-up', async () => {
    const u = await login(`apps-notify-${stamp}@example.test`);
    await mint(u.id, DEFAULTS);
    const grant = await prisma.oAuthGrant.findFirstOrThrow({ where: { userId: u.id, clientId: client.id, revokedAt: null } });

    const enqueue = jest.spyOn(app.get(JobsService), 'enqueue').mockResolvedValue({ id: 'job' } as never);
    app.get(ConnectedAppsGrantListener).onGrant({ userId: u.id, grantId: grant.id, clientId: client.id, resourceId: 'mcp', reason: 'created' });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: 'connected_apps.grant.notify', subjectId: grant.id, payload: { userId: u.id, grantId: grant.id, clientId: client.id, reason: 'created' } }));
    // Another protected resource's grants are not the console's apps.
    enqueue.mockClear();
    app.get(ConnectedAppsGrantListener).onGrant({ userId: u.id, grantId: grant.id, clientId: client.id, resourceId: 'other', reason: 'created' });
    expect(enqueue).not.toHaveBeenCalled();
    enqueue.mockRestore();

    const notify = jest.spyOn(app.get(NotificationsService), 'notify').mockResolvedValue(undefined as never);
    const handler = app.get(AppGrantNotifyHandler);
    const created = await handler.handle({ userId: u.id, grantId: grant.id, clientId: client.id, reason: 'created' });
    expect(created?.event).toBe(APP_CONNECTED_EVENT);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(APP_CONNECTED_EVENT, u.id, expect.objectContaining({ clientId: client.id, appName: HOST, scopes: expect.stringContaining('Delegate') }));

    // An update with no new scope: nothing. A step-up to browser:drive: app.scope_added.
    expect(await handler.handle({ userId: u.id, grantId: grant.id, clientId: client.id, reason: 'updated' })).toBeNull();
    await prisma.oAuthGrant.update({ where: { id: grant.id }, data: { scopes: [...grant.scopes, 'browser:drive'] } });
    const stepped = await handler.handle({ userId: u.id, grantId: grant.id, clientId: client.id, reason: 'updated' });
    expect(stepped).toMatchObject({ event: APP_SCOPE_ADDED_EVENT, data: { added: 'Drive browser', scopeIds: ['browser:drive'] } });
    // The same step-up again (a second job): announced once.
    expect(await handler.handle({ userId: u.id, grantId: grant.id, clientId: client.id, reason: 'updated' })).toBeNull();
    expect(notify).toHaveBeenCalledTimes(2);

    // A low-risk step-up is recorded, not announced.
    await prisma.oAuthGrant.update({ where: { id: grant.id }, data: { scopes: [...grant.scopes, 'browser:drive', 'offline_access'] } });
    expect(await handler.handle({ userId: u.id, grantId: grant.id, clientId: client.id, reason: 'updated' })).toBeNull();
    notify.mockRestore();
  });

  it('app.first_run: once per connection, after the run row committed', async () => {
    const u = await login(`apps-first-${stamp}@example.test`);
    const token = await mint(u.id);
    const notify = jest.spyOn(app.get(NotificationsService), 'notify').mockResolvedValue(undefined as never);
    await runGoal(`Bearer ${token}`, 'First one');
    await runGoal(`Bearer ${token}`, 'Second one');
    const firsts = notify.mock.calls.filter((c) => c[0] === APP_FIRST_RUN_EVENT);
    expect(firsts).toHaveLength(1);
    const [run] = await runsOf(u.id);
    expect(firsts[0]![2]).toMatchObject({ runId: run!.id, goal: 'First one', clientId: client.id });
    notify.mockRestore();
  });
});
