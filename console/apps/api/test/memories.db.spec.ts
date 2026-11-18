// Memories (#551) against a real, migrated and seeded database: the API, the
// label rule and the limit, supersede and its history, archive, delete,
// isolation (another user's id is a 404 on every route), the audit events
// (no label, no value), the export file and the user purge.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { MAX_ACTIVE_MEMORIES } from '../src/memories/memories.schemas';
import { memoryFileSchema } from '../src/memories/memory-transfer';
import { PrismaService } from '../src/prisma/prisma.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;

async function login(email: string, role: 'admin' | 'contributor' | 'viewer' = 'contributor'): Promise<{ token: string; userId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
const as = (token: string) => ({ authorization: `Bearer ${token}` });
const data = <T,>(res: { json: <U>() => U }): T => res.json<{ data: T }>().data;
const errCode = (res: { json: <U>() => U }): string => res.json<{ error?: { code?: string }; code?: string }>().error?.code ?? res.json<{ code?: string }>().code ?? '';

interface Memory {
  id: string;
  kind: string;
  label: string;
  aliases: string[];
  attributes: Record<string, string>;
  note: string | null;
  status: string;
  source: string;
  supersededById: string | null;
  history?: Memory[];
}

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app?.close();
});

async function add(token: string, body: Record<string, unknown>): Promise<Memory> {
  const res = await app.inject({ method: 'POST', url: '/api/memories', headers: as(token), payload: body });
  expect(res.statusCode).toBe(201);
  return data<Memory>(res);
}

describe('the memories API', () => {
  it('creates, lists with q, patches, supersedes with history, archives and deletes', async () => {
    const a = await login(`mem-crud-${stamp}@example.test`);
    const wife = await add(a.token, { kind: 'person', label: 'My wife', aliases: ['Wife', 'Paula'], attributes: { name: 'Person A', phone: '555-010-6020' } });
    expect(wife).toMatchObject({ kind: 'person', label: 'My wife', aliases: ['wife', 'paula'], status: 'active', source: 'owner' });
    await add(a.token, { kind: 'account', label: 'Checking account', attributes: { bank: 'Bank of Example', ending: '0659' } });

    const byQ = async (q: string) => data<Memory[]>(await app.inject({ method: 'GET', url: `/api/memories?q=${encodeURIComponent(q)}`, headers: as(a.token) })).map((m) => m.label);
    expect(await byQ('paula')).toEqual(['My wife']);
    expect(await byQ('0659')).toEqual(['Checking account']);
    expect(await byQ('WIFE')).toEqual(['My wife']);
    expect((await byQ('')).sort()).toEqual(['Checking account', 'My wife']);
    const accounts = data<Memory[]>(await app.inject({ method: 'GET', url: '/api/memories?kind=account', headers: as(a.token) }));
    expect(accounts.map((m) => m.label)).toEqual(['Checking account']);

    const patched = await app.inject({ method: 'PATCH', url: `/api/memories/${wife.id}`, headers: as(a.token), payload: { note: 'Uses Zelle', aliases: ['spouse'] } });
    expect(patched.statusCode).toBe(200);
    expect(data<Memory>(patched)).toMatchObject({ note: 'Uses Zelle', aliases: ['spouse'], attributes: { name: 'Person A' } });

    const next = await app.inject({ method: 'POST', url: `/api/memories/${wife.id}/supersede`, headers: as(a.token), payload: { attributes: { name: 'Person A', phone: '555-010-7777' } } });
    expect(next.statusCode).toBe(201);
    const v2 = data<Memory>(next);
    expect(v2).toMatchObject({ label: 'My wife', note: 'Uses Zelle', attributes: { phone: '555-010-7777' }, status: 'active' });
    const detail = data<Memory>(await app.inject({ method: 'GET', url: `/api/memories/${v2.id}`, headers: as(a.token) }));
    expect(detail.history?.map((h) => [h.id, h.status, h.supersededById, h.attributes.phone])).toEqual([[wife.id, 'superseded', v2.id, '555-010-6020']]);
    // The old version is not active and cannot be superseded again.
    expect(await byQ('6020')).toEqual([]);
    expect(errCode(await app.inject({ method: 'POST', url: `/api/memories/${wife.id}/supersede`, headers: as(a.token), payload: { attributes: { a: 'b' } } }))).toBe('MEMORY_NOT_ACTIVE');

    const archived = await app.inject({ method: 'POST', url: `/api/memories/${v2.id}/archive`, headers: as(a.token) });
    expect(data<Memory>(archived).status).toBe('archived');
    expect(await byQ('wife')).toEqual([]);
    const withArchived = data<Memory[]>(await app.inject({ method: 'GET', url: '/api/memories?status=archived', headers: as(a.token) }));
    expect(withArchived.map((m) => m.id)).toEqual([v2.id]);
    expect(data<Memory>(await app.inject({ method: 'POST', url: `/api/memories/${v2.id}/unarchive`, headers: as(a.token) })).status).toBe('active');

    expect((await app.inject({ method: 'DELETE', url: `/api/memories/${v2.id}`, headers: as(a.token) })).statusCode).toBe(204);
    // Deleted with its history.
    expect(await prisma.memory.count({ where: { id: { in: [wife.id, v2.id] } } })).toBe(0);
  });

  it('keeps labels unique among active memories, ignoring case', async () => {
    const a = await login(`mem-label-${stamp}@example.test`);
    const first = await add(a.token, { kind: 'preference', label: 'Seat', attributes: { seat: 'aisle' } });
    const dup = await app.inject({ method: 'POST', url: '/api/memories', headers: as(a.token), payload: { kind: 'preference', label: 'SEAT', attributes: {} } });
    expect(dup.statusCode).toBe(409);
    expect(errCode(dup)).toBe('MEMORY_LABEL_TAKEN');
    // An archived one frees the label; unarchiving it then clashes.
    await app.inject({ method: 'POST', url: `/api/memories/${first.id}/archive`, headers: as(a.token) });
    await add(a.token, { kind: 'preference', label: 'seat', attributes: { seat: 'window' } });
    expect(errCode(await app.inject({ method: 'POST', url: `/api/memories/${first.id}/unarchive`, headers: as(a.token) }))).toBe('MEMORY_LABEL_TAKEN');
    // Another user may use the same label.
    const b = await login(`mem-label-b-${stamp}@example.test`);
    await add(b.token, { kind: 'preference', label: 'Seat', attributes: {} });
  });

  it('refuses a 501st active memory', async () => {
    const a = await login(`mem-limit-${stamp}@example.test`);
    await prisma.memory.createMany({ data: Array.from({ length: MAX_ACTIVE_MEMORIES }, (_, i) => ({ userId: a.userId, kind: 'fact' as const, label: `Fact ${i}`, attributes: {}, source: 'owner' as const })) });
    const over = await app.inject({ method: 'POST', url: '/api/memories', headers: as(a.token), payload: { kind: 'fact', label: 'One more', attributes: {} } });
    expect(over.statusCode).toBe(409);
    expect(errCode(over)).toBe('MEMORY_LIMIT');
  });

  it('refuses Secret Material with MEMORY_HOLDS_SECRET, naming the field', async () => {
    const a = await login(`mem-secret-${stamp}@example.test`);
    for (const attributes of [{ password: 'hunter2' }, { card: '4242 4242 4242 4242' }, { account: '123456789012' }, { ssn: '123-45-6789' }]) {
      const res = await app.inject({ method: 'POST', url: '/api/memories', headers: as(a.token), payload: { kind: 'account', label: `Secret ${Object.keys(attributes)[0]}`, attributes } });
      expect(res.statusCode).toBe(422);
      expect(errCode(res)).toBe('MEMORY_HOLDS_SECRET');
      expect(JSON.stringify(res.json())).toContain(Object.keys(attributes)[0]!);
    }
    const ok = await add(a.token, { kind: 'person', label: 'Contact', attributes: { account: 'ending 0659', phone: '555-010-6020', email: 'person.a@example.test', name: 'Person A' } });
    const sup = await app.inject({ method: 'POST', url: `/api/memories/${ok.id}/supersede`, headers: as(a.token), payload: { attributes: { card: '4111111111111111' } } });
    expect(errCode(sup)).toBe('MEMORY_HOLDS_SECRET');
    expect(await prisma.memory.count({ where: { userId: a.userId } })).toBe(1);
  });

  it('never lets a body set source, status, userId or the source ids', async () => {
    const a = await login(`mem-body-${stamp}@example.test`);
    const other = '00000000-0000-4000-8000-000000000001';
    for (const extra of [{ source: 'agent_proposed' }, { status: 'archived' }, { userId: other }, { sourceRunId: other }, { sourceConversationId: other }]) {
      const res = await app.inject({ method: 'POST', url: '/api/memories', headers: as(a.token), payload: { kind: 'fact', label: `Body ${Object.keys(extra)[0]}`, attributes: {}, ...extra } });
      expect(res.statusCode).toBe(400);
    }
    expect(await prisma.memory.count({ where: { userId: a.userId } })).toBe(0);
  });

  it("answers 404 for another user's memory on every route", async () => {
    const a = await login(`mem-iso-a-${stamp}@example.test`);
    const b = await login(`mem-iso-b-${stamp}@example.test`);
    const m = await add(a.token, { kind: 'fact', label: 'Private', attributes: { x: 'y' } });
    const calls: [string, string, Record<string, unknown> | undefined][] = [
      ['GET', `/api/memories/${m.id}`, undefined],
      ['PATCH', `/api/memories/${m.id}`, { note: 'x' }],
      ['POST', `/api/memories/${m.id}/supersede`, { attributes: { x: 'z' } }],
      ['POST', `/api/memories/${m.id}/archive`, undefined],
      ['POST', `/api/memories/${m.id}/unarchive`, undefined],
      ['DELETE', `/api/memories/${m.id}`, undefined],
    ];
    for (const [method, url, payload] of calls) {
      const res = await app.inject({ method: method as 'GET', url, headers: as(b.token), ...(payload ? { payload } : {}) });
      expect([method, url, res.statusCode]).toEqual([method, url, 404]);
    }
    expect(data<Memory[]>(await app.inject({ method: 'GET', url: '/api/memories?status=all', headers: as(b.token) }))).toEqual([]);
    expect(await prisma.memory.findUnique({ where: { id: m.id } })).toMatchObject({ note: null, status: 'active' });
  });

  it('gives a viewer read but not write', async () => {
    const v = await login(`mem-viewer-${stamp}@example.test`, 'viewer');
    expect((await app.inject({ method: 'GET', url: '/api/memories', headers: as(v.token) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/memories', headers: as(v.token), payload: { kind: 'fact', label: 'x', attributes: {} } })).statusCode).toBe(403);
  });

  it('writes audit events with ids, kind and source only', async () => {
    const a = await login(`mem-audit-${stamp}@example.test`);
    const m = await add(a.token, { kind: 'person', label: 'Audit label zebra', aliases: ['zebraalias'], attributes: { name: 'Zebra value' }, note: 'zebra note' });
    const v2 = data<Memory>(await app.inject({ method: 'POST', url: `/api/memories/${m.id}/supersede`, headers: as(a.token), payload: { attributes: { name: 'Zebra value two' } } }));
    await app.inject({ method: 'POST', url: `/api/memories/${v2.id}/archive`, headers: as(a.token) });
    await app.inject({ method: 'GET', url: '/api/memories/export', headers: as(a.token) });
    await app.inject({ method: 'DELETE', url: `/api/memories/${v2.id}`, headers: as(a.token) });
    const events = await prisma.auditEvent.findMany({ where: { actorUserId: a.userId, action: { startsWith: 'memory.' } }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => e.action)).toEqual(['memory.created', 'memory.superseded', 'memory.archived', 'memory.exported', 'memory.deleted']);
    expect(events[0]!.meta).toMatchObject({ memoryId: m.id, kind: 'person', source: 'owner' });
    expect(JSON.stringify(events).toLowerCase()).not.toMatch(/zebra/);
  });

  it('exports a valid hexactra.memories file without ids', async () => {
    const a = await login(`mem-export-${stamp}@example.test`);
    const m = await add(a.token, { kind: 'person', label: 'My wife', attributes: { name: 'Person A' } });
    await app.inject({ method: 'POST', url: `/api/memories/${m.id}/supersede`, headers: as(a.token), payload: { attributes: { name: 'Person B' } } });
    const res = await app.inject({ method: 'GET', url: '/api/memories/export', headers: as(a.token) });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-disposition'])).toMatch(/attachment; filename="hexactra-memories-\d{8}\.json"/);
    const file = memoryFileSchema.parse(res.json());
    expect(file.memories).toHaveLength(1);
    expect(file.memories[0]).toMatchObject({ label: 'My wife', attributes: { name: 'Person B' }, source: 'owner', status: 'active' });
    expect(res.body).not.toContain(m.id);
    expect(res.body).not.toContain(a.userId);
  });

  it('deletes the memories with the user', async () => {
    const a = await login(`mem-purge-${stamp}@example.test`);
    await add(a.token, { kind: 'fact', label: 'Gone', attributes: {} });
    await prisma.user.delete({ where: { id: a.userId } });
    expect(await prisma.memory.count({ where: { userId: a.userId } })).toBe(0);
  });
});
