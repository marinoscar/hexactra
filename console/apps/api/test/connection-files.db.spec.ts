// The file routes of a connection (E39.10, #607) against a real database, the running API and the in-memory capability provider: browse
// spreadsheets and folders, one file, create a folder, make a picked file usable, the typed failures, ownership and permissions, and the
// picker session (Google only, Documents on, a token only in that one response, audited without it). Invented data only.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { CapabilityProviderRegistry } from '../src/connections/capability-provider.registry';
import { ConnectionProviderRegistry } from '../src/connections/connection-provider.registry';
import { ConnectionApps } from '../src/connections/connection-apps.service';
import { ConnectionTokensService } from '../src/connections/connection-tokens.service';
import { FakeCapabilityProvider } from '../src/connections/testing';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
const stamp = `${Date.now()}`;
const fake = new FakeCapabilityProvider('google');
let savedProvider: ReturnType<CapabilityProviderRegistry['get']>;
const TOKEN = 'ya29.MARKER-picker-token-6631';

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  const registry = app.get(CapabilityProviderRegistry);
  savedProvider = registry.get('google');
  registry.register(fake);
  jest.spyOn(app.get(ConnectionTokensService), 'getAccessToken').mockResolvedValue(TOKEN);
  jest.spyOn(app.get(ConnectionApps), 'system').mockResolvedValue({
    google: { enabled: true, clientId: '123456789012-abcdef.apps.googleusercontent.com', pickerApiKey: 'AIzaSyExampleKeyNotReal-0001' },
    microsoft: { enabled: false, clientId: null, tenant: 'common' },
  });
});
afterAll(async () => {
  jest.restoreAllMocks();
  const registry = app?.get(CapabilityProviderRegistry);
  if (savedProvider) registry?.register(savedProvider);
  else registry?.unregister('google');
  await app?.close();
});

interface Session {
  token: string;
  userId: string;
}
async function login(name: string, role: 'contributor' | 'viewer' = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
async function call<T = unknown>(s: Session, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${s.token}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const body = res.body && String(res.headers['content-type']).includes('json') ? (res.json() as { data?: T; code?: string; details?: Record<string, unknown> }) : {};
  return { status: res.statusCode, data: body.data as T, code: body.code ?? '', details: body.details, raw: res };
}

async function connection(user: Session, over: { provider?: 'google' | 'microsoft'; capabilities?: string[]; label?: string } = {}) {
  const provider = over.provider ?? 'google';
  const caps = (over.capabilities ?? ['docs_read', 'docs_write']) as never[];
  const scopes = app.get(ConnectionProviderRegistry).get(provider)?.scopesFor(caps) ?? [];
  return prisma.connection.create({
    data: { userId: user.userId, provider, accountId: `acct-${user.userId}-${provider}-${over.label ?? 'Work'}`, accountEmail: `acct-${stamp}@example.test`, label: over.label ?? 'Work', capabilities: caps, grantedScopes: scopes },
  });
}

describe('GET /api/connections/:id/files', () => {
  it('browses spreadsheets and folders by name and kind, a page at a time', async () => {
    const user = await login('files-a');
    const c = await connection(user);
    const a = fake.account(c.id);
    a.addFile({ id: 'sheet-loan', name: 'Loan payments', kind: 'spreadsheet', mimeType: 'application/vnd.google-apps.spreadsheet', parentId: null });
    a.addFile({ id: 'sheet-misc', name: 'Misc', kind: 'spreadsheet', mimeType: 'application/vnd.google-apps.spreadsheet', parentId: null });
    a.addFile({ id: 'folder-receipts', name: 'Receipts', kind: 'folder', mimeType: 'application/vnd.google-apps.folder', parentId: null });
    const sheets = await call<{ items: { id: string; name: string }[]; nextPageToken: string | null }>(user, 'GET', `/api/connections/${c.id}/files?type=spreadsheet`);
    expect(sheets.status).toBe(200);
    expect(sheets.data.items.map((f) => f.id).sort()).toEqual(['sheet-loan', 'sheet-misc']);
    const named = await call<{ items: { id: string }[] }>(user, 'GET', `/api/connections/${c.id}/files?type=spreadsheet&q=loan`);
    expect(named.data.items.map((f) => f.id)).toEqual(['sheet-loan']);
    const folders = await call<{ items: { id: string }[] }>(user, 'GET', `/api/connections/${c.id}/files?type=folder`);
    expect(folders.data.items.map((f) => f.id)).toEqual(['folder-receipts']);
  });

  it('answers one file with its address, and a missing one as CONNECTION_FILE_NOT_FOUND', async () => {
    const user = await login('files-b');
    const c = await connection(user);
    fake.account(c.id).addFile({ id: 'sheet-1', name: 'Loan payments', kind: 'spreadsheet', mimeType: 'application/vnd.google-apps.spreadsheet', parentId: null, webUrl: 'https://docs.example.test/sheet-1' });
    const ok = await call<{ id: string; webUrl: string }>(user, 'GET', `/api/connections/${c.id}/files/sheet-1`);
    expect(ok.status).toBe(200);
    expect(ok.data.webUrl).toBe('https://docs.example.test/sheet-1');
    const gone = await call(user, 'GET', `/api/connections/${c.id}/files/nope`);
    expect(gone.status).toBe(404);
    expect(gone.code).toBe('CONNECTION_FILE_NOT_FOUND');
  });

  it('refuses an account whose Documents switch is off, a paused one, and another user\'s as not found', async () => {
    const user = await login('files-c');
    const off = await connection(user, { capabilities: ['mail_read'], label: 'Mail only' });
    const r = await call(user, 'GET', `/api/connections/${off.id}/files`);
    expect(r.status).toBe(409);
    expect(r.code).toBe('CONNECTION_CAPABILITY_OFF');
    const paused = await prisma.connection.create({ data: { userId: user.userId, provider: 'google', accountId: `acct-paused-${stamp}`, accountEmail: 'p@example.test', label: 'Paused', capabilities: ['docs_read'], grantedScopes: [], status: 'paused' } });
    expect((await call(user, 'GET', `/api/connections/${paused.id}/files`)).code).toBe('CONNECTION_PAUSED');
    const other = await login('files-d');
    expect((await call(other, 'GET', `/api/connections/${off.id}/files`)).status).toBe(404);
  });

  it('needs connections:read', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/connections/00000000-0000-4000-8000-000000000000/files' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/connections/:id/folders and /files/picked', () => {
  it('creates a folder (inside another when asked) and audits it without the name', async () => {
    const user = await login('folders-a');
    const c = await connection(user);
    const made = await call<{ id: string; name: string; kind: string; parentId: string | null }>(user, 'POST', `/api/connections/${c.id}/folders`, { name: 'Loan receipts' });
    expect(made.status).toBe(201);
    expect(made.data.kind).toBe('folder');
    expect(made.data.name).toBe('Loan receipts');
    const inner = await call<{ parentId: string | null }>(user, 'POST', `/api/connections/${c.id}/folders`, { name: '2026', parentId: made.data.id });
    expect(inner.data.parentId).toBe(made.data.id);
    const audit = await prisma.auditEvent.findMany({ where: { actorUserId: user.userId, action: 'connection.folder_created' } });
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain('Loan receipts');
  });

  it('refuses a folder name with a control character, and a viewer', async () => {
    const user = await login('folders-b');
    const c = await connection(user);
    expect((await call(user, 'POST', `/api/connections/${c.id}/folders`, { name: 'a\nb' })).status).toBe(400);
    const viewer = await login('folders-viewer', 'viewer');
    expect([401, 403, 404]).toContain((await call(viewer, 'POST', `/api/connections/${c.id}/folders`, { name: 'x' })).status);
  });

  it('makes a picked file usable, and tells a file that was not picked from one that is missing', async () => {
    const user = await login('picked-a');
    const c = await connection(user);
    const a = fake.account(c.id);
    a.restrictToPicked = true;
    a.addFile({ id: 'file-picked', name: 'Picked sheet', kind: 'spreadsheet', mimeType: 'application/vnd.google-apps.spreadsheet', parentId: null });
    a.addFile({ id: 'file-other', name: 'Other sheet', kind: 'spreadsheet', mimeType: 'application/vnd.google-apps.spreadsheet', parentId: null });
    a.picked.add('file-picked');
    const ok = await call<{ id: string; kind: string }>(user, 'POST', `/api/connections/${c.id}/files/picked`, { fileId: 'file-picked' });
    expect(ok.status).toBe(200);
    expect(ok.data.kind).toBe('spreadsheet');
    const notPicked = await call(user, 'POST', `/api/connections/${c.id}/files/picked`, { fileId: 'file-other' });
    expect(notPicked.status).toBe(409);
    expect(notPicked.code).toBe('CONNECTION_PERMISSION_MISSING');
    const missing = await call(user, 'POST', `/api/connections/${c.id}/files/picked`, { fileId: 'file-none' });
    expect(missing.status).toBe(404);
    expect(missing.code).toBe('CONNECTION_FILE_NOT_FOUND');
  });
});

describe('POST /api/connections/:id/picker', () => {
  it('gives a Google account with Documents on a token, the project number and the key, and audits it without the token', async () => {
    const user = await login('picker-a');
    const c = await connection(user);
    const r = await call<{ accessToken: string; appId: string | null; apiKey: string | null }>(user, 'POST', `/api/connections/${c.id}/picker`);
    expect(r.status).toBe(200);
    expect(r.data.accessToken).toBe(TOKEN);
    expect(r.data.appId).toBe('123456789012');
    expect(r.data.apiKey).toBe('AIzaSyExampleKeyNotReal-0001');
    expect(String(r.raw.headers['cache-control'])).toContain('no-store');
    const audit = await prisma.auditEvent.findMany({ where: { actorUserId: user.userId, action: 'connection.picker_opened' } });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(TOKEN);
  });

  it('is only for Google, only with Documents on, and never for another user\'s connection', async () => {
    const user = await login('picker-b');
    const ms = await connection(user, { provider: 'microsoft', label: 'Outlook' });
    const notGoogle = await call(user, 'POST', `/api/connections/${ms.id}/picker`);
    expect(notGoogle.status).toBe(409);
    expect(notGoogle.code).toBe('CONNECTION_PICKER_UNAVAILABLE');
    expect(notGoogle.details?.reason).toBe('not_google');
    const noDocs = await connection(user, { capabilities: ['mail_read'], label: 'Mail' });
    expect((await call(user, 'POST', `/api/connections/${noDocs.id}/picker`)).details?.reason).toBe('no_documents');
    const other = await login('picker-c');
    expect((await call(other, 'POST', `/api/connections/${noDocs.id}/picker`)).status).toBe(404);
  });
});

describe('GET /api/connections/:id/activity', () => {
  it('lists the operation, time and run of tool calls and deliveries, and never any content', async () => {
    const user = await login('activity-a');
    const c = await connection(user, { label: 'Activity Work' });
    const other = await connection(user, { label: 'Elsewhere' });
    const run = await prisma.run.create({ data: { userId: user.userId, goal: 'g', status: 'succeeded' } });
    await prisma.runStep.createMany({
      data: [
        { runId: run.id, seq: 1, kind: 'action', action: 'mail_send', args: { connection: 'Activity Work' }, ok: true, summary: 'sent mail to person-a@example.test SUBJECT-MARK-9921' },
        { runId: run.id, seq: 2, kind: 'action', action: 'mail_search', args: { connection: 'Elsewhere' }, ok: true, summary: 'found 3 messages' },
        { runId: run.id, seq: 3, kind: 'action', action: 'click', args: { connection: 'Activity Work' }, ok: true, summary: 'clicked' },
        { runId: run.id, seq: 4, kind: 'action', action: 'sheet_append_rows', args: { connection: 'Activity Work' }, ok: false, summary: 'failed' },
      ],
    });
    const task = await prisma.task.create({ data: { userId: user.userId, name: 'Pay', goal: 'Pay' } });
    const delivery = await prisma.taskDelivery.create({ data: { userId: user.userId, taskId: task.id, kind: 'sheet_row', config: {}, connectionId: c.id } });
    await prisma.runDelivery.create({ data: { userId: user.userId, runId: run.id, deliveryId: delivery.id, kind: 'sheet_row', status: 'sent', sentAt: new Date() } });
    const r = await call<{ items: { kind: string; operation: string; ok: boolean; runId: string | null }[] }>(user, 'GET', `/api/connections/${c.id}/activity`);
    expect(r.status).toBe(200);
    expect(r.data.items.map((i) => `${i.kind}:${i.operation}:${i.ok}`).sort()).toEqual(['delivery:sheet_row:true', 'tool:mail_send:true', 'tool:sheet_append_rows:false']);
    expect(r.data.items.every((i) => i.runId === run.id)).toBe(true);
    expect(JSON.stringify(r.data)).not.toContain('SUBJECT-MARK-9921');
    expect(JSON.stringify(r.data)).not.toContain('person-a@example.test');
    const none = await call<{ items: unknown[] }>(user, 'GET', `/api/connections/${other.id}/activity`);
    expect(none.data.items.map((i) => (i as { operation: string }).operation)).toEqual(['mail_search']);
    const stranger = await login('activity-b');
    expect((await call(stranger, 'GET', `/api/connections/${c.id}/activity`)).status).toBe(404);
  });
});

describe('the run that an email started', () => {
  it('names its trigger in `mailTriggerId`, on the run and in the list', async () => {
    const user = await login('trigger-run');
    const c = await connection(user, { label: 'Trigger Work', capabilities: ['mail_read'] });
    const task = await prisma.task.create({ data: { userId: user.userId, name: 'Invoices', goal: 'Pay' } });
    const trigger = await prisma.mailTrigger.create({ data: { userId: user.userId, taskId: task.id, connectionId: c.id, name: 'Invoices', match: { from: ['billing@example.test'] } } });
    const run = await prisma.run.create({ data: { userId: user.userId, taskId: task.id, goal: 'Pay', status: 'succeeded', trigger: 'email', mailTriggerId: trigger.id } });
    const one = await call<{ mailTriggerId: string | null; trigger: string }>(user, 'GET', `/api/runs/${run.id}`);
    expect(one.status).toBe(200);
    expect(one.data.trigger).toBe('email');
    expect(one.data.mailTriggerId).toBe(trigger.id);
    const plain = await prisma.run.create({ data: { userId: user.userId, goal: 'g', status: 'succeeded' } });
    expect((await call<{ mailTriggerId: string | null }>(user, 'GET', `/api/runs/${plain.id}`)).data.mailTriggerId).toBeNull();
  });
});

describe('the task summary', () => {
  it('counts the deliveries that are switched on', async () => {
    const user = await login('summary-a');
    const created = await call<{ id: string }>(user, 'POST', '/api/tasks', { name: 'Pay', goal: 'Pay the bill' });
    expect(created.status).toBe(201);
    const list = async () => (await call<{ items: { id: string; summary?: { deliveries: number } }[] }>(user, 'GET', '/api/tasks?envelope=1&include=summary')).data.items.find((i) => i.id === created.data.id)?.summary?.deliveries;
    expect(await list()).toBe(0);
    await prisma.taskDelivery.createMany({
      data: [
        { userId: user.userId, taskId: created.data.id, kind: 'webhook', config: { url: 'https://hooks.example.test' }, enabled: true },
        { userId: user.userId, taskId: created.data.id, kind: 'webhook', config: { url: 'https://hooks.example.test/2' }, enabled: false },
      ],
    });
    expect(await list()).toBe(1);
  });
});
