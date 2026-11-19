// Which connections a task or a chat may use (E39.7, #604), through the API: the field on `POST`/`PATCH`, what is returned, the checks, what
// the Disconnect dialog lists and clears, and the AI app's `allowConnections` limit.
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

describe('a task lists its connections', () => {
  it('has none by default, takes them on create and replaces them on update, returning who and how', async () => {
    const s = await login('task');
    const work = await connection(s, 'Work');
    const home = await connection(s, 'Home');
    const plain = await call(s, 'POST', '/tasks', { name: 'Plain', goal: 'Do it' });
    expect(plain.status).toBe(201);
    expect(plain.data).toMatchObject({ connections: [], needsBrowser: 'auto' });

    const created = await call(s, 'POST', '/tasks', { name: 'With mail', goal: 'Read mail', needsBrowser: 'never', connections: [{ connectionId: work.id, access: 'read' }, { connectionId: home.id, access: 'read_write' }] });
    expect(created.status).toBe(201);
    expect(created.data.needsBrowser).toBe('never');
    expect(created.data.connections).toHaveLength(2);
    expect(created.data.connections).toEqual(
      expect.arrayContaining([
        { connectionId: home.id, access: 'read_write', label: 'Home', provider: 'google', accountEmail: 'home@example.test', status: 'active' },
        { connectionId: work.id, access: 'read', label: 'Work', provider: 'google', accountEmail: 'work@example.test', status: 'active' },
      ]),
    );
    const id = created.data.id as string;

    // An update that leaves the field out leaves the list; a list replaces it; [] switches every connection off.
    expect((await call(s, 'PATCH', `/tasks/${id}`, { name: 'Renamed' })).data.connections).toHaveLength(2);
    const replaced = await call(s, 'PATCH', `/tasks/${id}`, { connections: [{ connectionId: work.id, access: 'read_write' }] });
    expect(replaced.data.connections).toEqual([expect.objectContaining({ connectionId: work.id, access: 'read_write' })]);
    expect((await call(s, 'GET', `/tasks/${id}`)).data.connections).toHaveLength(1);
    expect((await call(s, 'GET', '/tasks')).data.find((t: { id: string }) => t.id === id).connections).toHaveLength(1);
    expect((await call(s, 'PATCH', `/tasks/${id}`, { connections: [] })).data.connections).toEqual([]);
    expect(await prisma.taskConnection.count({ where: { taskId: id } })).toBe(0);
  });

  it("refuses another owner's connection and a connection listed twice, and creates nothing", async () => {
    const a = await login('own-a');
    const b = await login('own-b');
    const mine = await connection(a, 'Mine');
    const theirs = await connection(b, 'Theirs');
    const foreign = await call(a, 'POST', '/tasks', { name: 'Bad', goal: 'x', connections: [{ connectionId: theirs.id, access: 'read' }] });
    expect(foreign.status).toBe(400);
    expect(foreign.code).toBe('CONNECTION_SELECTION_INVALID');
    expect(foreign.details).toEqual({ connectionIds: [theirs.id] });
    const twice = await call(a, 'POST', '/tasks', { name: 'Twice', goal: 'x', connections: [{ connectionId: mine.id, access: 'read' }, { connectionId: mine.id, access: 'read_write' }] });
    expect(twice.code).toBe('CONNECTION_SELECTION_INVALID');
    expect((await call(a, 'GET', '/tasks')).data.filter((t: { name: string }) => ['Bad', 'Twice'].includes(t.name))).toEqual([]);
    const badAccess = await call(a, 'POST', '/tasks', { name: 'Access', goal: 'x', connections: [{ connectionId: mine.id, access: 'write' }] });
    expect(badAccess.status).toBe(400);
  });

  it('lists the tasks and chats that use a connection when it is removed, and clears them', async () => {
    const s = await login('usage');
    const work = await connection(s, 'Work');
    const task = await call(s, 'POST', '/tasks', { name: 'Uses Work', goal: 'x', connections: [{ connectionId: work.id, access: 'read' }] });
    const chat = await call(s, 'POST', '/chats', { title: 'Mail chat', connections: [{ connectionId: work.id, access: 'read' }] });
    expect(chat.data.connections).toEqual([expect.objectContaining({ connectionId: work.id, access: 'read', label: 'Work' })]);
    const detail = await call(s, 'GET', `/connections/${work.id}`);
    expect(detail.data.usedBy).toEqual(expect.arrayContaining([{ kind: 'task', id: task.data.id, name: 'Uses Work' }, { kind: 'chat', id: chat.data.id, name: 'Mail chat' }]));
    await prisma.approvalRule.create({ data: { userId: s.userId, kind: 'connection', host: work.id, matchKey: 'mail_send', summary: 'Send mail with Work', recipients: ['person-b@example.test'] } });
    const removed = await call(s, 'DELETE', `/connections/${work.id}`);
    expect(await prisma.approvalRule.count({ where: { userId: s.userId, kind: 'connection' } })).toBe(0);
    expect(removed.status).toBe(200);
    expect((await call(s, 'GET', `/tasks/${task.data.id}`)).data.connections).toEqual([]);
    expect((await call(s, 'GET', `/chats/${chat.data.id}`)).data.connections).toEqual([]);
  });

  it('keeps a chat\'s list on update and returns it with the thread', async () => {
    const s = await login('chat');
    const work = await connection(s, 'Work');
    const chat = await call(s, 'POST', '/chats', {});
    expect(chat.data.connections).toEqual([]);
    const set = await call(s, 'PATCH', `/chats/${chat.data.id}`, { connections: [{ connectionId: work.id, access: 'read_write' }] });
    expect(set.data.connections).toEqual([expect.objectContaining({ connectionId: work.id, access: 'read_write' })]);
    expect((await call(s, 'PATCH', `/chats/${chat.data.id}`, { title: 'Renamed' })).data.connections).toHaveLength(1);
    expect((await call(s, 'GET', `/chats/${chat.data.id}`)).data.connections).toHaveLength(1);
    const list = await call(s, 'GET', '/chats');
    expect(list.data.items.find((c: { id: string }) => c.id === chat.data.id).connections).toHaveLength(1);
  });
});

describe('the AI app limit allowConnections', () => {
  it('is off by default, is the owner\'s to change, and is read into a run\'s snapshot', async () => {
    const s = await login('app');
    const clientId = randomUUID();
    await prisma.connectedAppSettings.create({ data: { userId: s.userId, clientId } });
    const apps = app.get(ConnectedAppsService);
    expect((await apps.limits(s.userId, clientId)).allowConnections).toBe(false);
    expect((await apps.patch(s.userId, clientId, { allowConnections: true })).allowConnections).toBe(true);
    expect((await apps.limits(s.userId, clientId)).allowConnections).toBe(true);
    expect(readAppLimits({ clientId, allowedDomains: [], allowConnections: true })?.allowConnections).toBe(true);
    expect(readAppLimits({ clientId, allowedDomains: [] })?.allowConnections).toBe(false);
    expect((await apps.patch(s.userId, clientId, { allowConnections: false })).allowConnections).toBe(false);
  });
});
