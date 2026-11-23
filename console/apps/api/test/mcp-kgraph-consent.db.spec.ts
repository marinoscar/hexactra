// E46.37 (#893; closes #796's "with the deployment switch off, tools/list is identical to main for every caller, and the consent screen
// shows no new scope in use"), against a real database and the whole app, with the Knowledge Graph's DEPLOYMENT switch off and the
// owner's own switch on (so the deployment switch alone decides).
//
// Generic over the Knowledge Graph: a "Knowledge Graph scope" is any scope that only feature-gated tools (`McpTool.feature`) use, and a
// "Knowledge Graph tool" is any feature-gated tool, so a scope or tool a later issue adds (E46.35's `site_facts:*`) is covered unchanged.
//
// "The list of main": the pinned manifest (__snapshots__/mcp-tools.json) less the Knowledge Graph tools. mcp-manifest.spec.ts pins every
// entry and forbids removing one, and that remainder equals origin/main's snapshot entry for entry (61 tools, same titles, hints and
// schema hashes, checked when this spec was written), so the wire list is compared, per caller, on names, order, titles, hints and the
// hashes of its schemas.
//
// What the console controls and what it does not (docs/security-hosted-clients.md, "Consent with the Knowledge Graph off"): the platform's
// OAuth server shows on the consent screen exactly the scopes a client asks for, and the resource's default scopes when it asks for none;
// the registered scopes are fixed at boot, so the protected-resource metadata lists every one of them whatever the switch. The console
// keeps the Knowledge Graph scopes out of the default consent, out of every step-up challenge, out of the scopes a card shows as held, and
// makes them useless while the switch is off (no tool listed, a call answers "turned off"). Those two platform behaviours are pinned at the
// end so this file fails, and the document is corrected, when an EnterpriseAppBase release adds the seam.
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { OAuthServerSettingsReader, PatService } from '@marinoscar/platform-api/identity';
import { createOAuthTestClient, mintOAuthTestToken, pkcePair, type OAuthTestClient } from '@marinoscar/platform-api/identity/testing';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { createApp } from '../src/main';
import { MCP_SCOPES } from '../src/mcp/mcp.scopes';
import { MCP_TOOLS } from '../src/mcp/mcp.tools';
import { PrismaService } from '../src/prisma/prisma.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
let appUrl: string;
let adminId: string;
let client: OAuthTestClient;
const stamp = randomUUID().slice(0, 8);
const HOST = `kg-consent-${stamp}.example.test`;
const workerMode = process.env.JOBS_WORKER_MODE;

/** Every feature-gated tool, and every scope only such tools use. */
const KG_TOOLS = MCP_TOOLS.filter((t) => t.feature).map((t) => t.name);
const KG_SCOPES: string[] = [...new Set(MCP_TOOLS.filter((t) => t.feature).map((t) => t.scope as string))].filter((s) => !MCP_TOOLS.some((t) => !t.feature && t.scope === s));
const ALL_SCOPES = MCP_SCOPES.map((s) => s.id as string);
const DEFAULTS = MCP_SCOPES.filter((s) => s.default).map((s) => s.id as string);
const isKgScope = (s: string) => KG_SCOPES.includes(s);

interface Entry {
  name: string;
  title: string;
  annotations: unknown;
  inputSchema: string | null;
  outputSchema: string | null;
}
const PINNED = JSON.parse(readFileSync(join(__dirname, '__snapshots__', 'mcp-tools.json'), 'utf8')) as Array<Entry & { scope: string; effect: string }>;
/** The list of main: every pinned entry but the Knowledge Graph tools, in registry order. */
const MAIN: Entry[] = PINNED.filter((e) => !KG_TOOLS.includes(e.name)).map(({ name, title, annotations, inputSchema, outputSchema }) => ({ name, title, annotations, inputSchema, outputSchema }));
const modelVisible = (name: string) => {
  const t = MCP_TOOLS.find((x) => x.name === name)!;
  return !t.visibility || t.visibility.includes('model');
};
/** The same hash mcp-manifest.spec.ts pins, over the schema as the wire carries it. */
const hash = (schema: unknown) => (schema === undefined ? null : createHash('sha256').update(JSON.stringify(schema)).digest('hex').slice(0, 16));

async function login(email: string, role: 'contributor' | 'admin' = 'contributor') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const id = (await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id;
  return { token, id };
}
const api = (token: string, method: 'GET' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api${url}`, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
async function rpc(token: string, body: unknown) {
  const res = await app.inject({ method: 'POST', url: '/api/mcp', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, payload: JSON.stringify(body) });
  return { status: res.statusCode, headers: res.headers, json: res.body ? JSON.parse(res.body) : null };
}
type WireTool = { name: string; title: string; annotations: unknown; inputSchema: unknown; outputSchema?: unknown };
type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> };
const wireList = async (token: string): Promise<WireTool[]> => {
  const r = await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  expect(r.status).toBe(200);
  return r.json.result.tools as WireTool[];
};
const asEntries = (tools: WireTool[]): Entry[] => tools.map((t) => ({ name: t.name, title: t.title, annotations: t.annotations, inputSchema: hash(t.inputSchema), outputSchema: hash(t.outputSchema) }));
const call = (token: string, name: string, args: Record<string, unknown> = {}) => rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
/** The scopes `tasks_list`'s card is told the connection holds (`granted_scopes`, #467). */
const shownAsHeld = async (token: string) => {
  const r = await call(token, 'tasks_list');
  expect(r.status).toBe(200);
  return (r.json.result as ToolResult).structuredContent!.granted_scopes as string[];
};
const pat = async (userId: string) => (await app.get(PatService).createToken(userId, { name: `kgc-${randomUUID().slice(0, 6)}`, durationValue: 1, durationUnit: 'days' } as never)).token;
async function mint(userId: string, scopes: readonly string[]): Promise<string> {
  await prisma.oAuthGrant.updateMany({ where: { userId, clientId: client.id, revokedAt: null }, data: { revokedAt: new Date() } });
  return (await mintOAuthTestToken(prisma as never, { userId, resourceId: 'mcp', scopes, appUrl, client: { id: client.id } })).token;
}
const deployment = async (enabled: boolean) => app.get(SystemSettingsService).patchSettings({ kgraph: { enabled } } as never, adminId);

/** The protected resource's and the authorization server's metadata, as a hosted client reads them (nginx's rewrite applied). */
async function metadata() {
  const prm = (await app.inject({ method: 'GET', url: '/api/oauth/.well-known/protected-resource/api/mcp' })).json() as { resource: string; scopes_supported: string[] };
  const as = (await app.inject({ method: 'GET', url: '/api/oauth/.well-known/authorization-server' })).json() as { authorization_endpoint: string; token_endpoint: string; scopes_supported: string[] };
  return { prm, as };
}

/** A hosted client's whole flow as `session`: authorize (with `scope`, or none), read the consent screen, approve it, exchange the code. */
async function connect(session: string, scope: string | null) {
  await prisma.oAuthGrant.updateMany({ where: { client: { id: client.id }, revokedAt: null }, data: { revokedAt: new Date() } });
  const { prm, as } = await metadata();
  const pkce = pkcePair();
  const query = new URLSearchParams({ response_type: 'code', client_id: client.clientId, redirect_uri: client.redirectUri, state: 's1', code_challenge: pkce.challenge, code_challenge_method: 'S256', resource: prm.resource, ...(scope !== null ? { scope } : {}) });
  const authorized = await app.inject({ method: 'GET', url: `${new URL(as.authorization_endpoint).pathname}?${query}` });
  expect(authorized.statusCode).toBe(302);
  const requestId = new URL(String(authorized.headers.location)).searchParams.get('request')!;
  const auth = { authorization: `Bearer ${session}` };
  const consent = await app.inject({ method: 'GET', url: `/api/oauth/requests/${requestId}`, headers: auth });
  expect(consent.statusCode).toBe(200);
  const decision = await app.inject({ method: 'POST', url: `/api/oauth/requests/${requestId}/decision`, headers: { ...auth, 'content-type': 'application/json' }, payload: JSON.stringify({ decision: 'approve' }) });
  expect(decision.statusCode).toBe(200);
  const code = new URL(decision.json().data.redirectTo).searchParams.get('code')!;
  const token = await app.inject({
    method: 'POST',
    url: new URL(as.token_endpoint).pathname,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.clientId, code, redirect_uri: client.redirectUri, code_verifier: pkce.verifier }).toString(),
  });
  expect(token.statusCode).toBe(200);
  const body = token.json() as { access_token: string; scope: string };
  return { shown: (consent.json().data.scopes as Array<{ id: string }>).map((s) => s.id), granted: body.scope.split(' ').filter((s) => s !== ''), token: body.access_token };
}

beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
  prisma = app.get(PrismaService);
  appUrl = app.get(ConfigService).get<string>('appUrl')!.replace(/\/+$/, '');
  adminId = (await login(`kgc-admin-${stamp}@example.test`, 'admin')).id;
  client = await createOAuthTestClient(prisma as never, { name: 'Scripted assistant', redirectUris: [`https://${HOST}/callback`], host: HOST, tokenEndpointAuthMethod: 'none' });
  await app.get(SystemSettingsService).patchSettings({ oauthServer: { enabled: true, allowedClientHosts: [HOST], allowAnyClientHost: false } } as never, adminId);
  app.get(OAuthServerSettingsReader).invalidate();
}, 120_000);

afterAll(async () => {
  try {
    if (app) {
      await deployment(false);
      await app.get(SystemSettingsService).patchSettings({ oauthServer: { enabled: false, allowedClientHosts: [] } } as never, adminId);
    }
  } finally {
    await prisma?.oAuthClient.deleteMany({ where: { id: client?.id } });
    await app?.close();
  }
});

/** An owner whose own switch is on: only the deployment switch keeps the Knowledge Graph off. */
async function owner(name: string) {
  const u = await login(`kgc-${name}-${stamp}@example.test`);
  expect((await api(u.token, 'PATCH', '/user-settings', { kgraph: { enabled: true } })).statusCode).toBe(200);
  return u;
}

describe('the Knowledge Graph scopes and tools with the deployment switch off (#796)', () => {
  it('knows which scopes and tools are the Knowledge Graph\'s, none of them is default, and the list of main has none of them', () => {
    expect(KG_TOOLS).toEqual(expect.arrayContaining(['procedures_list', 'procedure_get', 'procedure_run']));
    expect(KG_SCOPES).toEqual(expect.arrayContaining(['procedures:read', 'procedures:run']));
    expect(MCP_SCOPES.filter((s) => isKgScope(s.id)).map((s) => [s.id, s.default])).toEqual(KG_SCOPES.map((s) => [s, false]));
    expect(DEFAULTS.filter(isKgScope)).toEqual([]);
    expect(MAIN.map((e) => e.name).filter((n) => KG_TOOLS.includes(n))).toEqual([]);
    expect(MAIN.length).toBe(PINNED.length - KG_TOOLS.length);
  });

  it('tools/list is the list of main for a personal access token, a session, an OAuth app with every scope and one with the default scopes', async () => {
    await deployment(false);
    const o = await owner('list');
    const mainForPat = MAIN.filter((e) => modelVisible(e.name));
    // A personal access token and a session: every model-visible tool of main, nothing else, in the same order with the same schemas.
    expect(asEntries(await wireList(await pat(o.id)))).toEqual(mainForPat);
    expect(asEntries(await wireList(o.token))).toEqual(mainForPat);
    // An OAuth app (an MCP Apps host, so it also gets the app-only helpers) holding EVERY scope, the Knowledge Graph's included.
    expect(asEntries(await wireList(await mint(o.id, ALL_SCOPES)))).toEqual(MAIN);
    // An OAuth app with the default consent: what it holds, plus (step-up advertising, on by default) what it may ask for; of main only.
    const defaults = asEntries(await wireList(await mint(o.id, DEFAULTS)));
    expect(defaults.map((e) => e.name).filter((n) => KG_TOOLS.includes(n))).toEqual([]);
    expect(defaults).toEqual(MAIN.filter((e) => defaults.some((d) => d.name === e.name)));
  });

  it('a personal access token and a session: no Knowledge Graph scope is shown as held, and every Knowledge Graph tool answers "turned off"', async () => {
    await deployment(false);
    const o = await owner('pat');
    for (const token of [await pat(o.id), o.token]) {
      expect((await shownAsHeld(token)).filter(isKgScope)).toEqual([]);
      for (const name of KG_TOOLS) {
        const r = await call(token, name, { procedure_id: 'kgp-none' });
        expect([name, r.status, (r.json.result as ToolResult).isError, (r.json.result as ToolResult).content[0]!.text]).toEqual([name, 200, true, expect.stringContaining('is turned off')]);
      }
    }
  });

  it('an OAuth app with the default consent: the consent screen shows no Knowledge Graph scope, the token, the grant and Connected apps hold none, and no step-up asks for one', async () => {
    await deployment(false);
    const o = await owner('consent');
    const { shown, granted, token } = await connect(o.token, null);
    // The consent screen lists the default scopes, exactly, and none of the Knowledge Graph's.
    expect([...shown].sort()).toEqual([...DEFAULTS].sort());
    expect(shown.filter(isKgScope)).toEqual([]);
    expect(granted.filter(isKgScope)).toEqual([]);
    // Shown as in use nowhere: not in the platform's grants list, not on Connected apps, not on a card.
    const grants = (await api(o.token, 'GET', '/oauth/grants')).json().data as Array<{ scopes: Array<string | { id: string }> }>;
    expect(grants).toHaveLength(1);
    expect(grants.flatMap((g) => g.scopes.map((s) => (typeof s === 'string' ? s : s.id))).filter(isKgScope)).toEqual([]);
    const apps = (await api(o.token, 'GET', '/connected-apps')).json().data as Array<{ scopes: Array<{ id: string }> }>;
    expect(apps).toHaveLength(1);
    expect(apps[0]!.scopes.map((s) => s.id).filter(isKgScope)).toEqual([]);
    expect(await shownAsHeld(token)).toEqual(DEFAULTS);
    // Not offered by a step-up: a Knowledge Graph tool the token lacks the scope for answers "turned off" (200), never 403 insufficient_scope.
    for (const name of KG_TOOLS) {
      const r = await call(token, name, { procedure_id: 'kgp-none' });
      expect([name, r.status, String(r.headers['www-authenticate'] ?? '')]).toEqual([name, 200, '']);
      expect((r.json.result as ToolResult).content[0]!.text).toContain('is turned off');
      expect(JSON.stringify(r.json)).not.toMatch(new RegExp(KG_SCOPES.map((s) => s.replace(':', '\\:')).join('|')));
    }
    // A step-up for another tool names the scopes it holds and the one it lacks, never a Knowledge Graph scope.
    const stepUp = await call(token, 'browser_open', {});
    expect(stepUp.status).toBe(403);
    const challenge = String(stepUp.headers['www-authenticate']);
    expect(challenge).toContain('insufficient_scope');
    expect(challenge).toContain('browser:drive');
    expect(KG_SCOPES.filter((s) => challenge.includes(s))).toEqual([]);
  });

  it('with the switch ON the same default token is asked to step up for a Knowledge Graph tool: the switch is what keeps the scope out', async () => {
    const o = await owner('contrast');
    const token = await mint(o.id, DEFAULTS);
    await deployment(true);
    try {
      const r = await call(token, 'procedures_list', {});
      expect(r.status).toBe(403);
      expect(String(r.headers['www-authenticate'])).toContain('procedures:read');
    } finally {
      await deployment(false);
    }
  });

  it('an OAuth app explicitly granted every Knowledge Graph scope (the platform allows it): still no Knowledge Graph tool, no call, no scope shown as held, no REST route', async () => {
    await deployment(false);
    const o = await owner('explicit');
    const token = await mint(o.id, [...DEFAULTS, ...KG_SCOPES]);
    expect((await wireList(token)).map((t) => t.name).filter((n) => KG_TOOLS.includes(n))).toEqual([]);
    for (const name of KG_TOOLS) {
      const r = await call(token, name, { procedure_id: 'kgp-none' });
      expect([name, r.status, (r.json.result as ToolResult).content[0]!.text]).toEqual([name, 200, expect.stringContaining('is turned off')]);
    }
    expect((await shownAsHeld(token)).filter(isKgScope)).toEqual([]);
    // An oat_ token is confined to /api/mcp: the Knowledge Graph's REST routes refuse it.
    expect((await api(token, 'GET', '/kgraph/procedures')).statusCode).toBe(403);
  });

  // ---- what the console does not control (the platform's OAuth server); pinned so the doc stays honest ------------------------------

  it('platform: the metadata lists every registered scope, the Knowledge Graph\'s included, whatever the switch', async () => {
    await deployment(false);
    const { prm, as } = await metadata();
    for (const s of KG_SCOPES) {
      expect([s, prm.scopes_supported.includes(s)]).toEqual([s, true]);
      expect([s, as.scopes_supported.includes(s)]).toEqual([s, true]);
    }
  });

  it('platform: a client that ASKS for a Knowledge Graph scope sees it on the consent screen and can be granted it, whatever the switch', async () => {
    await deployment(false);
    const o = await owner('asks');
    const { shown, granted } = await connect(o.token, [...DEFAULTS, ...KG_SCOPES].join(' '));
    expect(KG_SCOPES.filter((s) => shown.includes(s))).toEqual(KG_SCOPES);
    expect(KG_SCOPES.filter((s) => granted.includes(s))).toEqual(KG_SCOPES);
  });
});
