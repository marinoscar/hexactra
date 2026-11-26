// Service credentials against a real database (E50.2, #972): the routes and their permissions for each role, a personal access
// token and a hosted AI app's OAuth token; the three tiers through the real credential stores; one user cannot touch another's key
// or the deployment's; the audit rows; deleting a user removes their keys; and a seeded-marker scan of every response, audit row,
// log line and stored row (the row is ciphertext and its hint holds no character of the key).
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { OAuthServerSettingsReader, PatService } from '@marinoscar/platform-api/identity';
import { createOAuthTestClient, mintOAuthTestToken, type OAuthTestClient } from '@marinoscar/platform-api/identity/testing';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { createApp } from '../src/main';
import { MCP_SCOPES } from '../src/mcp/mcp.scopes';
import { PrismaService } from '../src/prisma/prisma.service';
import { SERVICE_CREDENTIAL_PORT, type ServiceCredentialPort } from '../src/service-credentials/service-credential.port';
import { apiKeyShape, ServiceCredentialRegistry } from '../src/service-credentials/service-credential.registry';

const savedKey = process.env.SECRETS_ENCRYPTION_KEY;
process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
const stamp = randomUUID().slice(0, 8);
const MARKER = `MARKER${randomUUID().replace(/-/g, '')}`;
const HOST = `svc-cred-${stamp}.example.test`;
const SERVICE = `test_${stamp.replace(/[^a-z0-9]/g, 'x')}`;
const REF = { service: SERVICE, name: 'brave' };
const USER_ONLY = { service: SERVICE, name: 'personal' };
const OWN = `/api/service-credentials/${SERVICE}/brave`;
const ADMIN = `/api/service-credentials/admin/${SERVICE}/brave`;
const ORG = `/api/service-credentials/org/${SERVICE}/brave`;

let app: NestFastifyApplication;
let prisma: PrismaService;
let client: OAuthTestClient;
let appUrl: string;
const responses: string[] = [];
const logs: string[] = [];
const userIds: string[] = [];
const originalWrites = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };

interface Session {
  token: string;
  userId: string;
  orgId: string | null;
}
type Role = 'contributor' | 'viewer' | 'admin' | 'org_admin';

async function login(name: string, role: Role = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  const data = me.json<{ data: { id: string; activeOrg?: { id: string } | null } }>().data;
  userIds.push(data.id);
  return { token, userId: data.id, orgId: data.activeOrg?.id ?? null };
}

async function call(token: string, method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
  responses.push(`${res.statusCode} ${JSON.stringify(res.headers)} ${res.body}`);
  return { status: res.statusCode, body: res.body ? (res.json() as { data?: unknown; error?: { code?: string; details?: unknown }; code?: string; details?: unknown }) : null };
}
const codeOf = (r: Awaited<ReturnType<typeof call>>) => r.body?.error?.code ?? r.body?.code;

interface View {
  service: string;
  name: string;
  label: string;
  binding: string;
  tier: string | null;
  tiers: Record<'user' | 'organization' | 'system', { available: boolean; set: boolean; setAt: string | null }>;
}
const view = async (s: Session) => ((await call(s.token, 'GET', '/api/service-credentials')).body!.data as View[]).find((v) => v.service === SERVICE && v.name === 'brave')!;
const port = () => app.get<ServiceCredentialPort>(SERVICE_CREDENTIAL_PORT, { strict: false });
const resolveAs = async (s: Session) => {
  const r = await port().resolve(REF, { userId: s.userId, orgId: s.orgId });
  if (!r) return null;
  const value = r.value.expose((b) => b.toString('utf8'));
  r.value.wipe();
  return { tier: r.tier, value };
};

beforeAll(async () => {
  const capture = (sink: string[], write: typeof process.stdout.write) =>
    ((chunk: unknown, ...rest: unknown[]) => {
      sink.push(String(chunk));
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
  process.stdout.write = capture(logs, originalWrites.out);
  process.stderr.write = capture(logs, originalWrites.err);
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  appUrl = app.get(ConfigService).get<string>('appUrl')!.replace(/\/+$/, '');
  const registry = app.get(ServiceCredentialRegistry, { strict: false });
  registry.register({ ref: REF, label: 'Test search key', tiers: ['user', 'organization', 'system'], validate: apiKeyShape });
  registry.register({ ref: USER_ONLY, label: 'Personal only', tiers: ['user'], validate: apiKeyShape });
  client = await createOAuthTestClient(prisma as never, { name: 'Scripted assistant', redirectUris: [`https://${HOST}/callback`], host: HOST, tokenEndpointAuthMethod: 'none' });
}, 120_000);

afterAll(async () => {
  process.stdout.write = originalWrites.out;
  process.stderr.write = originalWrites.err;
  try {
    await prisma?.credential.deleteMany({ where: { purpose: 'service_credential', name: { startsWith: `${SERVICE}.` } } });
    await prisma?.oAuthClient.deleteMany({ where: { id: client?.id } });
  } finally {
    await app?.close();
    if (savedKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = savedKey;
  }
});

describe('the tiers through the real stores', () => {
  it('a user sets and removes their own key; the deployment key answers after it; the organization key in between', async () => {
    const admin = await login('svc-admin', 'admin');
    const owner = await login('svc-owner', 'org_admin');
    const other = await login('svc-other');
    expect(owner.orgId).toEqual(expect.any(String)); // the test login puts every user in the default organization

    expect(await view(owner)).toMatchObject({ label: 'Test search key', binding: 'credential_store', tier: null, tiers: { user: { available: true, set: false, setAt: null }, system: { available: true, set: false } } });
    expect(await resolveAs(owner)).toBeNull();

    expect((await call(admin.token, 'PUT', ADMIN, { value: `${MARKER}-system` })).status).toBe(204);
    expect(await resolveAs(other)).toEqual({ tier: 'system', value: `${MARKER}-system` });

    if (owner.orgId) {
      expect((await call(owner.token, 'PUT', ORG, { value: `${MARKER}-org` })).status).toBe(204);
      expect(await resolveAs(owner)).toEqual({ tier: 'organization', value: `${MARKER}-org` });
      expect((await view(owner)).tiers.organization).toMatchObject({ available: true, set: true, setAt: expect.any(String) });
    }

    expect((await call(owner.token, 'PUT', OWN, { value: `${MARKER}-own` })).status).toBe(204);
    expect(await resolveAs(owner)).toEqual({ tier: 'user', value: `${MARKER}-own` });
    const v = await view(owner);
    expect(v).toMatchObject({ tier: 'user', tiers: { user: { set: true, setAt: expect.any(String) }, system: { set: true } } });
    // Another user does not see the owner's key as theirs and cannot reach it.
    expect((await view(other)).tiers.user.set).toBe(false);
    expect((await resolveAs(other))?.tier).not.toBe('user');

    expect((await call(owner.token, 'DELETE', OWN)).status).toBe(204);
    expect((await call(owner.token, 'DELETE', OWN)).status).toBe(204); // idempotent
    expect((await resolveAs(owner))?.tier).toBe(owner.orgId ? 'organization' : 'system');
    if (owner.orgId) expect((await call(owner.token, 'DELETE', ORG)).status).toBe(204);
    expect(await resolveAs(owner)).toEqual({ tier: 'system', value: `${MARKER}-system` });

    const audit = await prisma.auditEvent.findMany({ where: { targetType: 'service_credential', targetId: `${SERVICE}.brave` }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => [a.action, (a.meta as { tier: string }).tier])).toEqual([
      ['service_credential.set', 'system'],
      ...(owner.orgId ? [['service_credential.set', 'organization']] : []),
      ['service_credential.set', 'user'],
      ['service_credential.removed', 'user'],
      ['service_credential.removed', 'user'],
      ...(owner.orgId ? [['service_credential.removed', 'organization']] : []),
    ]);
    const orgRows = audit.filter((a) => (a.meta as { tier: string }).tier === 'organization');
    for (const a of orgRows) expect(a.orgId).toBe(owner.orgId);
  });

  it('refuses an unregistered reference, a tier the reference does not allow, a malformed name and a value of the wrong shape', async () => {
    const admin = await login('svc-refuse-admin', 'admin');
    const s = await login('svc-refuse');
    const unknown = await call(s.token, 'PUT', `/api/service-credentials/${SERVICE}/unknown`, { value: `${MARKER}-unknown` });
    expect([unknown.status, codeOf(unknown)]).toEqual([404, 'SERVICE_CREDENTIAL_UNKNOWN']);
    const tier = await call(admin.token, 'PUT', `/api/service-credentials/admin/${SERVICE}/personal`, { value: `${MARKER}-tier` });
    expect([tier.status, codeOf(tier)]).toEqual([409, 'SERVICE_CREDENTIAL_TIER_NOT_ALLOWED']);
    expect((await call(s.token, 'PUT', `/api/service-credentials/Bad/brave`, { value: `${MARKER}-bad-name` })).status).toBe(400);
    const shape = await call(s.token, 'PUT', OWN, { value: `${MARKER} with spaces` });
    expect([shape.status, codeOf(shape)]).toEqual([422, 'SERVICE_CREDENTIAL_INVALID']);
    expect((await call(s.token, 'PUT', OWN, { value: '' })).status).toBe(400);
    expect((await call(s.token, 'PUT', OWN, { value: `${MARKER}-too-long`.padEnd(5000, 'x') })).status).toBe(400);
    expect((await call(s.token, 'PUT', OWN, { value: `${MARKER}-extra`, other: 1 })).status).toBe(400);
    expect(await prisma.userCredential.count({ where: { userId: s.userId, purpose: 'service_credential' } })).toBe(0);
  });
});

describe('permissions', () => {
  it('each role: own key for contributors and admins; the deployment key for administrators; the organization key for organization administrators', async () => {
    const expected: Record<Role, { list: boolean; own: boolean; admin: boolean; org: boolean }> = {
      admin: { list: true, own: true, admin: true, org: true },
      org_admin: { list: true, own: true, admin: false, org: true },
      contributor: { list: true, own: true, admin: false, org: false },
      viewer: { list: false, own: false, admin: false, org: false },
    };
    for (const role of Object.keys(expected) as Role[]) {
      const s = await login(`svc-perm-${role}`, role);
      const allowed = (status: number) => status !== 401 && status !== 403;
      const list = await call(s.token, 'GET', '/api/service-credentials');
      const own = await call(s.token, 'PUT', OWN, { value: `${MARKER}-${role}-own` });
      const adm = await call(s.token, 'PUT', ADMIN, { value: `${MARKER}-${role}-admin` });
      const org = await call(s.token, 'PUT', ORG, { value: `${MARKER}-${role}-org` });
      const got = { list: allowed(list.status), own: allowed(own.status), admin: allowed(adm.status), org: allowed(org.status) };
      // `org` for a role that holds the permission may answer 409 without an active organization; it is still not a 403.
      expect([role, got]).toEqual([role, { ...expected[role], org: expected[role].org && (s.orgId !== null || org.status === 409) }]);
      if (got.own) expect((await call(s.token, 'DELETE', OWN)).status).toBe(204);
      if (got.org && s.orgId) expect((await call(s.token, 'DELETE', ORG)).status).toBe(204);
      expect((await call(s.token, 'DELETE', ADMIN)).status).toBe(expected[role].admin ? 204 : 403);
    }
  });

  it('a personal access token can set and list its owner\'s key but never read a value: there is no read route', async () => {
    const u = await login('svc-pat');
    const pat = await app.get(PatService).createToken(u.userId, { name: 'script', durationValue: 1, durationUnit: 'days' } as never);
    expect((await call(pat.token, 'PUT', OWN, { value: `${MARKER}-pat` })).status).toBe(204);
    const list = await call(pat.token, 'GET', '/api/service-credentials');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(MARKER);
    for (const url of [`${OWN}/value`, `/api/service-credentials/${SERVICE}/brave/reveal`, `/api/service-credentials/${SERVICE}`]) {
      expect((await call(pat.token, 'GET', url)).status).toBe(404);
    }
    expect((await call(pat.token, 'PUT', ADMIN, { value: `${MARKER}-pat-admin` })).status).toBe(403);
    expect((await call(pat.token, 'DELETE', OWN)).status).toBe(204);
  });

  it('a hosted AI app\'s OAuth token reaches none of the routes', async () => {
    const u = await login('svc-oauth');
    await app.get(SystemSettingsService).patchSettings({ oauthServer: { enabled: true, allowedClientHosts: [HOST], allowAnyClientHost: false } } as never, u.userId);
    app.get(OAuthServerSettingsReader).invalidate();
    try {
      const token = (await mintOAuthTestToken(prisma as never, { userId: u.userId, resourceId: 'mcp', scopes: MCP_SCOPES.map((s) => s.id), appUrl, client: { id: client.id } })).token;
      for (const [m, url, body] of [
        ['GET', '/api/service-credentials', undefined],
        ['PUT', OWN, { value: `${MARKER}-oauth` }],
        ['DELETE', OWN, undefined],
        ['PUT', ADMIN, { value: `${MARKER}-oauth` }],
        ['PUT', ORG, { value: `${MARKER}-oauth` }],
      ] as const) {
        const r = await call(token, m, url, body);
        expect([m, url, r.status === 401 || r.status === 403]).toEqual([m, url, true]);
      }
      expect(await prisma.userCredential.count({ where: { userId: u.userId, purpose: 'service_credential' } })).toBe(0);
    } finally {
      await app.get(SystemSettingsService).patchSettings({ oauthServer: { enabled: false, allowedClientHosts: [] } } as never, u.userId);
      app.get(OAuthServerSettingsReader).invalidate();
    }
  });
});

describe('deleting a user', () => {
  it('removes their keys with them', async () => {
    const u = await login('svc-gone');
    expect((await call(u.token, 'PUT', OWN, { value: `${MARKER}-gone` })).status).toBe(204);
    expect(await prisma.userCredential.count({ where: { userId: u.userId, purpose: 'service_credential' } })).toBe(1);
    await prisma.user.delete({ where: { id: u.userId } });
    expect(await prisma.userCredential.count({ where: { userId: u.userId } })).toBe(0);
  });
});

describe('nothing secret is ever shown', () => {
  it('no response, audit row, log line or stored row holds a seeded value; the rows are ciphertext with a hint free of the key', async () => {
    const s = await login('svc-scan');
    expect((await call(s.token, 'PUT', OWN, { value: `${MARKER}-scan` })).status).toBe(204);
    const rows = [
      ...(await prisma.userCredential.findMany({ where: { purpose: 'service_credential' } })),
      ...(await prisma.credential.findMany({ where: { purpose: 'service_credential' } })),
      ...(await prisma.orgCredential.findMany({ where: { purpose: 'service_credential' } })),
    ];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.hint ?? '').not.toMatch(/MARKER|scan|-own|-system|-org/);
    const audit = JSON.stringify(await prisma.auditEvent.findMany({ where: { OR: [{ actorUserId: { in: userIds } }, { targetType: 'service_credential' }] } }));
    for (const [where, text] of [
      ['responses', responses.join('\n')],
      ['audit', audit],
      ['logs', logs.join('')],
      ['rows', JSON.stringify(rows)],
    ] as const) {
      expect([where, text.includes(MARKER)]).toEqual([where, false]);
    }
  });
});
