// The per-task and per-chat connection lists are gone (E50.17, #987): every run and chat may use everything its owner switched on. Through
// the API: the deprecated `connections` and `connectionsMode` fields are accepted and ignored (no row is written, `[]` and `all` answered),
// the old `connections.newChats` setting still parses and decides nothing, what the Disconnect dialog lists and clears, and the AI app's
// `allowConnections` limit (on for a new app; a stored value is kept).
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { randomUUID } from 'node:crypto';
import { readAppLimits } from '../src/policies/policy-snapshot';
import { ConnectedAppsService } from '../src/connected-apps/connected-apps.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await prisma?.connection.deleteMany({ where: { accountId: { endsWith: `-${stamp}` } } });
  await app?.close();
});

interface Session {
  token: string;
  userId: string;
}
async function login(name: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `tc-${name}-${stamp}@example.test`, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
async function call(s: Session, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({ method, url: `/api${url}`, headers: { authorization: `Bearer ${s.token}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const body = res.body ? (res.json() as { data?: any; error?: { code?: string; details?: any }; code?: string; details?: any }) : {};
  return { status: res.statusCode, data: body.data, code: body.error?.code ?? body.code, details: body.error?.details ?? body.details };
}
async function connection(s: Session, label: string) {
  return prisma.connection.create({ data: { userId: s.userId, provider: 'google', accountId: `a-${label}-${stamp}`, accountEmail: `${label.toLowerCase()}@example.test`, label, capabilities: ['mail_read', 'calendar_read'], grantedScopes: ['mail_read', 'calendar_read'] } });
}

describe('a task and a chat have no connection list (E50.17)', () => {
  it('accepts the deprecated fields on a task, ignores them, writes no row and answers all and []', async () => {
    const s = await login('task');
    const work = await connection(s, 'Work');
    const plain = await call(s, 'POST', '/tasks', { name: 'Plain', goal: 'Do it' });
    expect(plain.status).toBe(201);
    expect(plain.data).toMatchObject({ connections: [], connectionsMode: 'all', needsBrowser: 'auto' });
    const created = await call(s, 'POST', '/tasks', { name: 'With mail', goal: 'Read mail', connectionsMode: 'listed', connections: [{ connectionId: work.id, access: 'read' }] });
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ connections: [], connectionsMode: 'all' });
    const id = created.data.id as string;
    expect(await prisma.taskConnection.count({ where: { taskId: id } })).toBe(0);
    const patched = await call(s, 'PATCH', `/tasks/${id}`, { connectionsMode: 'listed', connections: [{ connectionId: work.id, access: 'read_write' }] });
    expect(patched.status).toBe(200);
    expect(patched.data).toMatchObject({ connections: [], connectionsMode: 'all' });
    expect(await prisma.taskConnection.count({ where: { taskId: id } })).toBe(0);
    expect((await call(s, 'GET', '/tasks')).data.find((t: { id: string }) => t.id === id)).toMatchObject({ connections: [], connectionsMode: 'all' });
    // The field is still validated as it was: a value that is not an access is refused.
    expect((await call(s, 'POST', '/tasks', { name: 'Access', goal: 'x', connections: [{ connectionId: work.id, access: 'write' }] })).status).toBe(400);
  });

  it("ignores another owner's connection named in the deprecated field: nothing of theirs is listed or written", async () => {
    const a = await login('own-a');
    const b = await login('own-b');
    const theirs = await connection(b, 'Theirs');
    const created = await call(a, 'POST', '/tasks', { name: 'Foreign', goal: 'x', connections: [{ connectionId: theirs.id, access: 'read' }] });
    expect(created.status).toBe(201);
    expect(created.data.connections).toEqual([]);
    expect(await prisma.taskConnection.count({ where: { connectionId: theirs.id } })).toBe(0);
  });

  it('accepts and ignores the field on a chat, on create and on update', async () => {
    const s = await login('chat');
    const work = await connection(s, 'Work');
    const chat = await call(s, 'POST', '/chats', { connectionsMode: 'listed', connections: [{ connectionId: work.id, access: 'read' }] });
    expect(chat.status).toBe(201);
    expect(chat.data).toMatchObject({ connections: [], connectionsMode: 'all' });
    const set = await call(s, 'PATCH', `/chats/${chat.data.id}`, { connectionsMode: 'listed', connections: [{ connectionId: work.id, access: 'read_write' }] });
    expect(set.status).toBe(200);
    expect(set.data.connections).toEqual([]);
    expect(await prisma.conversationConnection.count({ where: { conversationId: chat.data.id } })).toBe(0);
    expect((await call(s, 'GET', '/chats')).data.items.find((c: { id: string }) => c.id === chat.data.id).connections).toEqual([]);
  });

  it('keeps the old new-chat setting readable and lets it decide nothing', async () => {
    const s = await login('def');
    await connection(s, 'Work');
    expect((await call(s, 'PATCH', '/user-settings', { connections: { newChats: 'off' } })).status).toBe(200);
    expect((await call(s, 'GET', '/user-settings')).data.connections?.newChats).toBe('off');
    expect((await call(s, 'POST', '/chats', {})).data.connections).toEqual([]);
    expect(await prisma.conversationConnection.count({ where: { conversation: { userId: s.userId } } })).toBe(0);
  });

  it('lists no task or chat as a use of a connection when it is removed, clears old rows and the saved approvals', async () => {
    const s = await login('usage');
    const work = await connection(s, 'Work');
    const task = await call(s, 'POST', '/tasks', { name: 'Uses Work', goal: 'x' });
    // A row left from before E50.17.
    await prisma.taskConnection.create({ data: { taskId: task.data.id, connectionId: work.id, access: 'read' } });
    const detail = await call(s, 'GET', `/connections/${work.id}`);
    expect((detail.data.usedBy ?? []).filter((u: { kind: string }) => u.kind === 'task' || u.kind === 'chat')).toEqual([]);
    await prisma.approvalRule.create({ data: { userId: s.userId, kind: 'connection', host: work.id, matchKey: 'mail_send', summary: 'Send mail with Work', recipients: ['person-b@example.test'] } });
    const removed = await call(s, 'DELETE', `/connections/${work.id}`);
    expect(removed.status).toBe(200);
    expect(await prisma.approvalRule.count({ where: { userId: s.userId, kind: 'connection' } })).toBe(0);
    expect(await prisma.taskConnection.count({ where: { taskId: task.data.id } })).toBe(0);
  });
});

describe('the AI app limit allowConnections', () => {
  it("is on for a new app, keeps a stored value, is the owner's to change, and is read into a run's snapshot", async () => {
    const s = await login('app');
    const apps = app.get(ConnectedAppsService);
    // A new app (no row yet, or a row created now) has it on.
    expect((await apps.limits(s.userId, randomUUID())).allowConnections).toBe(true);
    const clientId = randomUUID();
    await prisma.connectedAppSettings.create({ data: { userId: s.userId, clientId } });
    expect((await apps.limits(s.userId, clientId)).allowConnections).toBe(true);
    // An app saved before keeps the value it had.
    const kept = randomUUID();
    await prisma.connectedAppSettings.create({ data: { userId: s.userId, clientId: kept, allowConnections: false } });
    expect((await apps.limits(s.userId, kept)).allowConnections).toBe(false);
    expect((await apps.patch(s.userId, clientId, { allowConnections: false })).allowConnections).toBe(false);
    expect((await apps.limits(s.userId, clientId)).allowConnections).toBe(false);
    expect(readAppLimits({ clientId, allowedDomains: [], allowConnections: true })?.allowConnections).toBe(true);
    // A snapshot taken before the field existed reads it as off.
    expect(readAppLimits({ clientId, allowedDomains: [] })?.allowConnections).toBe(false);
  });
});
