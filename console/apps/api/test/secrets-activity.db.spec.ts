// The Activity list against a real, migrated database (E37.4, #593): the fabric's `secrets.*` events become sanitized,
// de-duplicated rows; the routes list the owner's own uses, the logins used so far and the administrator's counts;
// a seeded marker placed everywhere a value could leak never reaches a row or a response; permissions.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { FabricClient } from '../src/fabric/fabric.client';
import { PrismaService } from '../src/prisma/prisma.service';
import { SecretsActivityIngestHandler, SecretsActivityIngestTask } from '../src/secrets/secrets-activity.jobs';
import { SecretsActivityService } from '../src/secrets/secrets-activity.service';
import { SecretsPolicyService } from '../src/secrets/secrets-policy.service';
import { RunDeleteService } from '../src/tasks/run-delete.service';

const stamp = `${Date.now()}`;
const MARKER = `MARKER-secret-value-${randomUUID()}`;

let app: NestFastifyApplication;
let prisma: PrismaService;
let service: SecretsActivityService;
let fabric: FabricClient;
const responses: string[] = [];

interface Session {
  token: string;
  userId: string;
}
async function login(name: string, role: 'contributor' | 'viewer' | 'admin' = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
async function get<T>(s: Session | null, url: string): Promise<{ statusCode: number; data: T }> {
  const res = await app.inject({ method: 'GET', url, headers: s ? { authorization: `Bearer ${s.token}` } : {} });
  responses.push(res.body);
  return { statusCode: res.statusCode, data: (res.body ? res.json() : {}).data as T };
}

let seq = 0;
const op = () => randomUUID();
function ev(userId: string, type: 'secrets.lookup' | 'secrets.release', data: Record<string, unknown>, at = new Date()) {
  return { seq: ++seq, type, at: at.toISOString(), data: { owner_id: userId, op_id: op(), session_id: op(), provider: 'vault', origin: 'https://app.example.test', outcome: 'typed', released: false, ...data } };
}

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  service = app.get(SecretsActivityService, { strict: false });
  fabric = app.get(FabricClient, { strict: false });
});
afterAll(async () => {
  jest.restoreAllMocks();
  await app?.close();
});

describe('ingest', () => {
  it('stores one sanitized row per event, once, and never a value placed anywhere in the event', async () => {
    const alice = await login('act-alice');
    const mallory = await login('act-mallory');
    const run = await prisma.run.create({ data: { userId: alice.userId, goal: 'Sign in', status: 'succeeded' } as never, select: { id: true } });
    const itemId = randomUUID();
    const events = [
      ev(alice.userId, 'secrets.lookup', { kind: 'login', count: 1, outcome: 'ok', run_id: run.id }),
      // The marker is everywhere a value could ride: unknown keys, free-text columns, the origin's path, query and user info.
      ev(alice.userId, 'secrets.release', {
        run_id: run.id,
        item_id: itemId,
        field: 'password',
        purpose: 'login',
        released: true,
        origin: `https://user:${MARKER}@app.example.test/login?password=${MARKER}#${MARKER}`,
        client_label: MARKER,
        value: MARKER,
        password: MARKER,
        code: MARKER,
        message: MARKER,
      }),
      ev(alice.userId, 'secrets.release', { run_id: run.id, item_id: itemId, field: 'username', purpose: 'login', released: true }),
      ev(alice.userId, 'secrets.release', { run_id: run.id, item_id: itemId, field: 'one_time_code', purpose: 'mfa', released: true, outcome: MARKER }),
      ev(alice.userId, 'secrets.release', { item_id: itemId, field: 'password', purpose: 'login', origin: 'https://evil.example.test', outcome: 'origin_mismatch', run_id: MARKER }),
      // Another owner's event naming Alice's run: the run is not linked.
      ev(mallory.userId, 'secrets.release', { run_id: run.id, item_id: randomUUID(), field: 'password', purpose: 'login', released: true }),
      // An owner who is not a user of this console, and garbage: skipped.
      ev(randomUUID(), 'secrets.release', { field: 'password' }),
      { type: 'secrets.release', at: 'never', data: {} },
    ];
    expect(await service.ingest(events)).toBe(6);
    // Reading the same events again changes nothing.
    expect(await service.ingest(events)).toBe(0);

    const rows = await prisma.secretsActivity.findMany({ where: { userId: { in: [alice.userId, mallory.userId] } }, orderBy: { occurredAt: 'asc' } });
    expect(rows).toHaveLength(6);
    expect(JSON.stringify(rows)).not.toContain(MARKER);
    const pw = rows.find((r) => r.field === 'password' && r.outcome === 'typed' && r.userId === alice.userId)!;
    expect(pw).toMatchObject({ event: 'release', site: 'app.example.test', purpose: 'login', itemId, runId: run.id, released: true, provider: 'vault' });
    expect(rows.find((r) => r.field === 'one_time_code')).toMatchObject({ outcome: 'other' });
    expect(rows.find((r) => r.outcome === 'origin_mismatch')).toMatchObject({ site: 'evil.example.test', runId: null });
    expect(rows.find((r) => r.userId === mallory.userId)).toMatchObject({ runId: null });
    expect(rows.find((r) => r.event === 'lookup')).toMatchObject({ matches: 1, itemId: null, field: null });

    // The whole table, any column, any row: no marker (the database scan).
    const dump = await prisma.$queryRawUnsafe<{ t: string }[]>(`SELECT row_to_json(s)::text AS t FROM secrets_activity s`);
    expect(dump.some((r) => r.t.includes(MARKER))).toBe(false);

    // The owner's list: only theirs, newest first, no value, no other owner.
    const list = await get<{ items: Record<string, unknown>[]; providerActivityUrl: string | null }>(alice, '/api/secrets/activity');
    expect(list.statusCode).toBe(200);
    expect(list.data.items).toHaveLength(5);
    expect(list.data.items.every((i) => ['id', 'at', 'event', 'runId', 'site', 'field', 'outcome', 'refused', 'matches'].every((k) => k in i) && Object.keys(i).length === 9)).toBe(true);
    expect(list.data.items.filter((i) => i.refused).map((i) => i.outcome).sort()).toEqual(['origin_mismatch', 'other']);
    expect(list.data.providerActivityUrl).toBeNull();
    const times = list.data.items.map((i) => String(i.at));
    expect([...times].sort().reverse()).toEqual(times);
    expect((await get<{ items: unknown[] }>(mallory, '/api/secrets/activity')).data.items).toHaveLength(1);

    // The logins used so far: the typed fields of one login, in a fixed order; a refusal is not a use.
    const reach = await get<{ listing: string; items: { site: string; fields: string[]; uses: number; lastRunId: string | null }[] }>(alice, '/api/secrets/reach');
    expect(reach.data.listing).toBe('per_origin');
    expect(reach.data.items).toEqual([expect.objectContaining({ site: 'app.example.test', fields: ['username', 'password'], uses: 2, lastRunId: run.id })]);

    expect(responses.join('\n')).not.toContain(MARKER);
  });

  it('keeps the newest 100 and drops rows past the retention', async () => {
    const u = await login('act-many');
    const base = Date.now() - 3_600_000;
    await service.ingest(Array.from({ length: 105 }, (_, i) => ev(u.userId, 'secrets.release', { item_id: 'item-1', field: 'username', purpose: 'login', released: true }, new Date(base + i * 1000))));
    const list = await get<{ items: { at: string }[] }>(u, '/api/secrets/activity');
    expect(list.data.items).toHaveLength(100);
    expect(list.data.items[0]!.at).toBe(new Date(base + 104_000).toISOString());

    const old = new Date(Date.now() - 200 * 86_400_000);
    await service.ingest([ev(u.userId, 'secrets.release', { field: 'password' }, old)]);
    expect(await prisma.secretsActivity.count({ where: { userId: u.userId, occurredAt: old } })).toBe(1);
    expect(await service.purge()).toBeGreaterThanOrEqual(1);
    expect(await prisma.secretsActivity.count({ where: { userId: u.userId, occurredAt: old } })).toBe(0);
    expect(await prisma.secretsActivity.count({ where: { userId: u.userId } })).toBe(105);
  });

  it('outlives a deleted run: the row stays and forgets the run', async () => {
    const u = await login('act-rundel');
    const run = await prisma.run.create({ data: { userId: u.userId, goal: 'Sign in', status: 'succeeded' } as never, select: { id: true } });
    await service.ingest([ev(u.userId, 'secrets.release', { field: 'password', item_id: 'rd-1', run_id: run.id, released: true, purpose: 'login' })]);
    expect((await get<{ items: { runId: string | null }[] }>(u, '/api/secrets/activity')).data.items[0]!.runId).toBe(run.id);
    await app.get(RunDeleteService, { strict: false }).deleteOne(u.userId, run.id);
    const after = await get<{ items: { runId: string | null }[] }>(u, '/api/secrets/activity');
    expect(after.data.items).toHaveLength(1);
    expect(after.data.items[0]!.runId).toBeNull();
  });

  it('is deleted with the user', async () => {
    const u = await login('act-gone');
    await service.ingest([ev(u.userId, 'secrets.release', { field: 'password', item_id: 'x1' })]);
    await prisma.user.delete({ where: { id: u.userId } });
    expect(await prisma.secretsActivity.count({ where: { userId: u.userId } })).toBe(0);
  });
});

describe('the job', () => {
  it('reads the fabric and stores; a fabric that is not reachable stores nothing and does not fail', async () => {
    const u = await login('act-job');
    const spy = jest.spyOn(fabric, 'secretsEvents').mockResolvedValue([ev(u.userId, 'secrets.release', { field: 'password', item_id: 'job-1', released: true, purpose: 'login' })]);
    const handler = app.get(SecretsActivityIngestHandler, { strict: false });
    await handler.process({ id: 'job-x' } as never);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await prisma.secretsActivity.count({ where: { userId: u.userId } })).toBe(1);
    spy.mockRejectedValue(Object.assign(new Error('down'), { name: 'FabricError', kind: 'unreachable' }));
    // A non-FabricError is a real failure: the job fails and is retried.
    await expect(handler.process({ id: 'job-y' } as never)).rejects.toThrow('down');
    spy.mockRestore();
  });

  it('the cron only decides: due when the deployment switch is on or an owner is connected', async () => {
    const task = app.get(SecretsActivityIngestTask, { strict: false });
    const policy = app.get(SecretsPolicyService, { strict: false });
    jest.spyOn(policy, 'system').mockResolvedValue({ agentUse: { enabled: true }, vault: { baseUrl: null, clientId: null, allowedHosts: [] } });
    expect(await task.due()).toBe(true);
    jest.spyOn(policy, 'system').mockResolvedValue({ agentUse: { enabled: false }, vault: { baseUrl: null, clientId: null, allowedHosts: [] } });
    const connected = await prisma.secretsConnection.count({ where: { status: 'connected' } });
    expect(await task.due()).toBe(connected > 0);
  });
});

describe('permissions and the administrator view', () => {
  it('needs a signed-in user with secrets:read; a viewer may read their own', async () => {
    expect((await get(null, '/api/secrets/activity')).statusCode).toBe(401);
    expect((await get(null, '/api/secrets/reach')).statusCode).toBe(401);
    const viewer = await login('act-viewer', 'viewer');
    expect((await get(viewer, '/api/secrets/activity')).statusCode).toBe(200);
    expect((await get(viewer, '/api/secrets/reach')).statusCode).toBe(200);
  });

  it('the summary is for system_settings:read and holds counts only: no owner, no site, no login', async () => {
    const contributor = await login('act-contrib');
    expect((await get(contributor, '/api/secrets/admin/summary')).statusCode).toBe(403);
    const admin = await login('act-admin', 'admin');
    const owner = await login('act-owner');
    await service.ingest([
      ev(owner.userId, 'secrets.release', { field: 'password', item_id: 'sum-1', released: true, purpose: 'login', origin: 'https://private-bank.example.test' }),
      ev(owner.userId, 'secrets.release', { field: 'password', item_id: 'sum-1', outcome: 'origin_mismatch' }),
    ]);
    const r = await get<Record<string, unknown>>(admin, '/api/secrets/admin/summary');
    expect(r.statusCode).toBe(200);
    expect(Object.keys(r.data).sort()).toEqual(['deploymentEnabled', 'refusalsThisWeek', 'usersConnected', 'usersNeedingReconnect', 'usesThisWeek']);
    expect(r.data.usesThisWeek as number).toBeGreaterThanOrEqual(1);
    expect(r.data.refusalsThisWeek as number).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(r.data)).not.toMatch(/private-bank|example\.test|sum-1/);
  });
});
