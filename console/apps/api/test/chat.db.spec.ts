// The db tier: chats (#483) against a real, migrated and seeded database:
// create, list, read, post, rename, archive, delete, and who may do what.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Prisma } from '@prisma/client';

import { ChatService } from '../src/chat/chat.service';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { RunDeleteService } from '../src/tasks/run-delete.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
let chats: ChatService;
const stamp = `${Date.now()}`;

// No job worker in this app: a posted message queues a `chat.turn` job (#484) that this suite does not run.
const workerMode = process.env.JOBS_WORKER_MODE;
beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
  prisma = app.get(PrismaService);
  chats = app.get(ChatService, { strict: false });
  // No object storage in this test: a deleted run has no screenshots to remove.
  Object.assign(app.get(RunDeleteService, { strict: false }), { store: { delete: async () => undefined } });
});
afterAll(async () => {
  await app?.close();
});

type Session = { token: string; userId: string };
async function login(name: string, role: 'contributor' | 'viewer' = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `chat-${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}

interface Reply<T> {
  statusCode: number;
  code?: string;
  data: T;
}
async function call<T = unknown>(s: Session | null, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<Reply<T>> {
  const res = await app.inject({ method, url: `/api${url}`, headers: s ? { authorization: `Bearer ${s.token}` } : {}, ...(payload === undefined ? {} : { payload: payload as object }) });
  const body = res.body ? res.json<{ data?: T; code?: string; error?: { code?: string } }>() : {};
  return { statusCode: res.statusCode, code: body.code ?? body.error?.code, data: body.data as T };
}

interface Chat {
  id: string;
  title: string;
  status: 'active' | 'archived';
  profile: string;
  hostId: string | null;
  hostFallback: boolean;
  policyId: string | null;
  lastMessageAt: string;
}
interface Message {
  id: string;
  seq: number;
  role: string;
  kind: string;
  text: string;
  runId: string | null;
}
interface ListItem extends Chat {
  preview: { role: string; kind: string; text: string } | null;
  liveRun: { id: string; status: string } | null;
}
interface Page {
  items: ListItem[];
  nextCursor: string | null;
}
interface Detail extends Chat {
  messages: Message[];
  hasMore: boolean;
  liveRun: { id: string; status: string } | null;
}

const newChat = async (s: Session, body: Record<string, unknown> = {}) => (await call<Chat>(s, 'POST', '/chats', body)).data;
const say = (s: Session, id: string, text: string) => call<Message>(s, 'POST', `/chats/${id}/messages`, { text });
async function run(userId: string, conversationId: string, status: Prisma.RunCreateManyInput['status'] = 'succeeded'): Promise<string> {
  const row = await prisma.run.create({ data: { userId, conversationId, goal: 'Book two seats', status, trigger: 'chat' }, select: { id: true } });
  return row.id;
}

describe('POST /chats and GET /chats/:id', () => {
  it('creates a chat with defaults and reads it back empty', async () => {
    const alice = await login('create');
    const made = await call<Chat>(alice, 'POST', '/chats', {});
    expect(made.statusCode).toBe(201);
    expect(made.data).toMatchObject({ title: '', status: 'active', profile: 'default', hostId: null, hostFallback: true, policyId: null, allowedDomains: [], confirmRiskyActions: true });
    expect(made.data).not.toHaveProperty('answeredSeq');
    expect(made.data).not.toHaveProperty('turnLeaseUntil');
    expect(made.data).not.toHaveProperty('userId');
    expect(made.data).not.toHaveProperty('nextSeq');

    const read = await call<Detail>(alice, 'GET', `/chats/${made.data.id}`);
    expect(read.statusCode).toBe(200);
    expect(read.data).toMatchObject({ id: made.data.id, messages: [], hasMore: false, liveRun: null, thinking: false });
  });

  it('keeps the run settings it is given and refuses a policy that is not the caller\'s', async () => {
    const alice = await login('settings');
    const chat = await newChat(alice, { title: 'Cinema', profile: 'work', hostFallback: false, policyId: 'builtin:economy' });
    expect(chat).toMatchObject({ title: 'Cinema', profile: 'work', hostFallback: false, policyId: 'builtin:economy' });
    const bad = await call(alice, 'POST', '/chats', { policyId: '00000000-0000-4000-8000-000000000000' });
    expect(bad.statusCode).toBe(400);
    expect(bad.code).toBe('POLICY_REF_INVALID');
  });
});

describe('POST /chats/:id/messages', () => {
  it('appends in order, names an untitled chat after its first message and moves it up the list', async () => {
    const alice = await login('post');
    const chat = await newChat(alice);
    const first = await say(alice, chat.id, '  Book two seats\n for the 7:30 showing  ');
    expect(first.statusCode).toBe(201);
    expect(first.data).toMatchObject({ seq: 1, role: 'user', kind: 'text', text: 'Book two seats\n for the 7:30 showing', runId: null });
    expect((await say(alice, chat.id, 'Row F if you can')).data.seq).toBe(2);

    const read = (await call<Detail>(alice, 'GET', `/chats/${chat.id}`)).data;
    expect(read.title).toBe('Book two seats for the 7:30 showing');
    expect(read.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(Date.parse(read.lastMessageAt)).toBeGreaterThanOrEqual(Date.parse(chat.lastMessageAt));
  });

  it('does not rename a chat that has a title, and clips a long first message to 80 characters', async () => {
    const alice = await login('title');
    const named = await newChat(alice, { title: 'Groceries' });
    await say(alice, named.id, 'Order the usual');
    expect((await call<Detail>(alice, 'GET', `/chats/${named.id}`)).data.title).toBe('Groceries');

    const long = await newChat(alice);
    await say(alice, long.id, 'x'.repeat(300));
    const title = (await call<Detail>(alice, 'GET', `/chats/${long.id}`)).data.title;
    expect(title).toHaveLength(80);
    expect(title.endsWith('…')).toBe(true);
  });

  it('gives concurrent posts distinct, gapless sequence numbers', async () => {
    const alice = await login('concurrent');
    const chat = await newChat(alice);
    const replies = await Promise.all(Array.from({ length: 12 }, (_, i) => say(alice, chat.id, `message ${i}`)));
    expect(replies.every((r) => r.statusCode === 201)).toBe(true);
    expect(replies.map((r) => r.data.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it('returns only newer messages with afterSeq', async () => {
    const alice = await login('after');
    const chat = await newChat(alice);
    for (const t of ['one', 'two', 'three']) await say(alice, chat.id, t);
    const newer = (await call<Detail>(alice, 'GET', `/chats/${chat.id}?afterSeq=2`)).data;
    expect(newer.messages.map((m) => m.text)).toEqual(['three']);
    expect((await call<Detail>(alice, 'GET', `/chats/${chat.id}?afterSeq=3`)).data.messages).toEqual([]);
  });

  it('rejects an empty or oversized message', async () => {
    const alice = await login('invalid');
    const chat = await newChat(alice);
    expect((await say(alice, chat.id, '   ')).statusCode).toBe(400);
    expect((await say(alice, chat.id, 'x'.repeat(8001))).statusCode).toBe(400);
  });

  it('appends service messages (the turn engine) with the next number', async () => {
    const alice = await login('append');
    const chat = await newChat(alice);
    await say(alice, chat.id, 'Find a stroller');
    const asked = await chats.append(chat.id, { role: 'assistant', kind: 'clarify', text: 'Which budget?', meta: { options: ['Under $100', 'Any'] } });
    expect(asked).toMatchObject({ seq: 2, role: 'assistant', kind: 'clarify', meta: { options: ['Under $100', 'Any'] } });
  });
});

describe('GET /chats', () => {
  it('lists the newest activity first with a one-line preview and the live run, and pages by cursor', async () => {
    const alice = await login('list');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await newChat(alice, { title: `Chat ${i}` });
      ids.push(c.id);
      await say(alice, c.id, `hello\n\nfrom chat ${i}`);
    }
    const empty = await newChat(alice, { title: 'Empty' });
    const liveRun = await run(alice.userId, ids[0]!, 'running');
    await run(alice.userId, ids[1]!, 'succeeded');

    const first = (await call<Page>(alice, 'GET', '/chats?limit=4')).data;
    expect(first.items.map((c) => c.id)).toEqual([empty.id, ids[4], ids[3], ids[2]]);
    expect(first.items[0]!.preview).toBeNull();
    expect(first.items[1]!.preview).toEqual({ role: 'user', kind: 'text', text: 'hello from chat 4' });
    expect(first.items[0]).not.toHaveProperty('messages');
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = (await call<Page>(alice, 'GET', `/chats?limit=4&cursor=${encodeURIComponent(first.nextCursor!)}`)).data;
    expect(second.items.map((c) => c.id)).toEqual([ids[1], ids[0]]);
    expect(second.nextCursor).toBeNull();
    expect(second.items[1]!.liveRun).toEqual({ id: liveRun, status: 'running' });
    expect(second.items[0]!.liveRun).toBeNull();

    const bad = await call(alice, 'GET', '/chats?cursor=not-a-cursor');
    expect(bad.statusCode).toBe(400);
    expect(bad.code).toBe('INVALID_CURSOR');
  });

  it('clips the preview and separates active from archived', async () => {
    const alice = await login('filter');
    const kept = await newChat(alice, { title: 'Kept' });
    const gone = await newChat(alice, { title: 'Archived' });
    await say(alice, kept.id, 'y'.repeat(500));
    await call(alice, 'PATCH', `/chats/${gone.id}`, { status: 'archived' });

    const active = (await call<Page>(alice, 'GET', '/chats')).data.items;
    expect(active.map((c) => c.id)).toEqual([kept.id]);
    expect(active[0]!.preview!.text).toHaveLength(140);
    expect((await call<Page>(alice, 'GET', '/chats?status=archived')).data.items.map((c) => c.id)).toEqual([gone.id]);
    expect((await call(alice, 'GET', '/chats?status=deleted')).statusCode).toBe(400);
  });
});

describe('PATCH /chats/:id', () => {
  it('renames, changes the run settings, archives and unarchives', async () => {
    const alice = await login('patch');
    const chat = await newChat(alice);
    const renamed = await call<Chat>(alice, 'PATCH', `/chats/${chat.id}`, { title: 'Weekly shop', profile: 'home', policyId: 'builtin:economy' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.data).toMatchObject({ title: 'Weekly shop', profile: 'home', policyId: 'builtin:economy' });
    expect((await call<Chat>(alice, 'PATCH', `/chats/${chat.id}`, { policyId: null })).data.policyId).toBeNull();
    const limited = await call<Chat & { allowedDomains: string[]; confirmRiskyActions: boolean }>(alice, 'PATCH', `/chats/${chat.id}`, { allowedDomains: ['Shop.Example.test', '*.example.test'], confirmRiskyActions: false });
    expect(limited.data).toMatchObject({ allowedDomains: ['shop.example.test', '*.example.test'], confirmRiskyActions: false });
    expect((await call(alice, 'PATCH', `/chats/${chat.id}`, { allowedDomains: ['not a host'] })).statusCode).toBe(400);

    expect((await call<Chat>(alice, 'PATCH', `/chats/${chat.id}`, { status: 'archived' })).data.status).toBe('archived');
    const refused = await say(alice, chat.id, 'Still there?');
    expect(refused.statusCode).toBe(409);
    expect(refused.code).toBe('CHAT_ARCHIVED');
    expect((await call<Detail>(alice, 'GET', `/chats/${chat.id}`)).data.messages).toEqual([]);

    await call(alice, 'PATCH', `/chats/${chat.id}`, { status: 'active' });
    expect((await say(alice, chat.id, 'Back')).statusCode).toBe(201);
  });

  it('rejects an empty patch, an empty title and a foreign policy', async () => {
    const alice = await login('patch-bad');
    const chat = await newChat(alice);
    expect((await call(alice, 'PATCH', `/chats/${chat.id}`, {})).statusCode).toBe(400);
    expect((await call(alice, 'PATCH', `/chats/${chat.id}`, { title: '  ' })).statusCode).toBe(400);
    expect((await call(alice, 'PATCH', `/chats/${chat.id}`, { policyId: '00000000-0000-4000-8000-000000000000' })).code).toBe('POLICY_REF_INVALID');
  });
});

describe('DELETE /chats/:id', () => {
  it('removes the chat, its messages and its finished runs; a second call is 404', async () => {
    const alice = await login('delete');
    const chat = await newChat(alice);
    await say(alice, chat.id, 'Book it');
    const done = await run(alice.userId, chat.id, 'succeeded');
    await chats.append(chat.id, { role: 'assistant', kind: 'result', text: 'Booked', runId: done });
    const other = await newChat(alice);
    const untouched = await run(alice.userId, other.id, 'succeeded');

    expect((await call(alice, 'DELETE', `/chats/${chat.id}`)).statusCode).toBe(204);
    expect(await prisma.conversation.count({ where: { id: chat.id } })).toBe(0);
    expect(await prisma.chatMessage.count({ where: { conversationId: chat.id } })).toBe(0);
    expect(await prisma.run.count({ where: { id: done } })).toBe(0);
    expect(await prisma.run.count({ where: { id: untouched } })).toBe(1);
    const again = await call(alice, 'DELETE', `/chats/${chat.id}`);
    expect(again.statusCode).toBe(404);
    expect(again.code).toBe('CHAT_NOT_FOUND');
  });

  it.each(['queued', 'running', 'waiting_human'] as const)('refuses while a run is %s and deletes nothing', async (status) => {
    const alice = await login(`delete-${status}`);
    const chat = await newChat(alice);
    const done = await run(alice.userId, chat.id, 'failed');
    const live = await run(alice.userId, chat.id, status);
    const res = await call(alice, 'DELETE', `/chats/${chat.id}`);
    expect(res.statusCode).toBe(409);
    expect(res.code).toBe('CHAT_RUN_LIVE');
    expect(await prisma.conversation.count({ where: { id: chat.id } })).toBe(1);
    expect(await prisma.run.count({ where: { id: { in: [done, live] } } })).toBe(2);
  });

  it('keeps a message when its run is deleted from the Runs page', async () => {
    const alice = await login('run-gone');
    const chat = await newChat(alice);
    const done = await run(alice.userId, chat.id, 'succeeded');
    await chats.append(chat.id, { role: 'assistant', kind: 'result', text: 'Done', runId: done });
    expect((await call(alice, 'DELETE', `/runs/${done}`)).statusCode).toBe(204);
    expect((await call<Detail>(alice, 'GET', `/chats/${chat.id}`)).data.messages).toMatchObject([{ kind: 'result', text: 'Done', runId: null }]);
  });
});

describe('who may do what', () => {
  it('answers 401 without a session on every route', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const routes: Array<['GET' | 'POST' | 'PATCH' | 'DELETE', string]> = [['GET', '/chats'], ['POST', '/chats'], ['GET', `/chats/${id}`], ['PATCH', `/chats/${id}`], ['DELETE', `/chats/${id}`], ['POST', `/chats/${id}/messages`]];
    for (const [method, url] of routes) expect((await call(null, method, url, method === 'GET' || method === 'DELETE' ? undefined : {})).statusCode).toBe(401);
  });

  it('lets a viewer (chat:read only) read and nothing else', async () => {
    const viewer = await login('viewer', 'viewer');
    const row = await prisma.conversation.create({ data: { userId: viewer.userId, title: 'Read only' } });
    expect((await call<Page>(viewer, 'GET', '/chats')).data.items.map((c) => c.id)).toEqual([row.id]);
    expect((await call(viewer, 'GET', `/chats/${row.id}`)).statusCode).toBe(200);
    expect((await call(viewer, 'POST', '/chats', {})).statusCode).toBe(403);
    expect((await call(viewer, 'PATCH', `/chats/${row.id}`, { title: 'x' })).statusCode).toBe(403);
    expect((await call(viewer, 'POST', `/chats/${row.id}/messages`, { text: 'hi' })).statusCode).toBe(403);
    expect((await call(viewer, 'DELETE', `/chats/${row.id}`)).statusCode).toBe(403);
  });

  it("answers 404, never 403, for another user's chat, and never lists it", async () => {
    const alice = await login('owner');
    const mallory = await login('other');
    const chat = await newChat(alice, { title: 'Private' });
    await say(alice, chat.id, 'secret plans');

    for (const res of [
      await call(mallory, 'GET', `/chats/${chat.id}`),
      await call(mallory, 'PATCH', `/chats/${chat.id}`, { title: 'Mine now' }),
      await call(mallory, 'POST', `/chats/${chat.id}/messages`, { text: 'hi' }),
      await call(mallory, 'DELETE', `/chats/${chat.id}`),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.code).toBe('CHAT_NOT_FOUND');
    }
    expect((await call<Page>(mallory, 'GET', '/chats')).data.items).toEqual([]);
    const still = (await call<Detail>(alice, 'GET', `/chats/${chat.id}`)).data;
    expect(still.title).toBe('Private');
    expect(still.messages).toHaveLength(1);
  });
});

describe('runs of a chat', () => {
  it('carry conversationId and are filtered by trigger=chat', async () => {
    const alice = await login('runs');
    const chat = await newChat(alice);
    const id = await run(alice.userId, chat.id, 'succeeded');
    await prisma.run.create({ data: { userId: alice.userId, goal: 'Unrelated', status: 'succeeded', trigger: 'manual' } });

    const one = await call<{ conversationId: string | null; trigger: string }>(alice, 'GET', `/runs/${id}`);
    expect(one.data).toMatchObject({ conversationId: chat.id, trigger: 'chat' });
    const listed = (await call<Array<{ id: string; conversationId: string | null }>>(alice, 'GET', '/runs?trigger=chat')).data;
    expect(listed).toMatchObject([{ id, conversationId: chat.id }]);
  });
});
