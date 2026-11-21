// The db tier: the task builder's data and routes (E42.1, #718): create, read,
// post, change the spec, who may do what, and that a builder is never a chat
// in the list nor taken up by the chat's turn engine.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { ChatTurnService } from '../src/chat/chat-turn.service';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;

const workerMode = process.env.JOBS_WORKER_MODE;
beforeAll(async () => {
  // No job worker: a posted message queues a `chat.turn` job that this suite does not run.
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
async function login(name: string, role: 'contributor' | 'viewer' = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `builder-${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}

interface Reply<T> {
  statusCode: number;
  code?: string;
  data: T;
  details?: unknown;
}
async function call<T = unknown>(s: Session | null, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown): Promise<Reply<T>> {
  const res = await app.inject({ method, url: `/api${url}`, headers: s ? { authorization: `Bearer ${s.token}` } : {}, ...(payload === undefined ? {} : { payload: payload as object }) });
  const body = res.body ? res.json<{ data?: T; code?: string; details?: unknown; error?: { code?: string; details?: unknown } }>() : {};
  return { statusCode: res.statusCode, code: body.code ?? body.error?.code, data: body.data as T, details: body.details ?? body.error?.details };
}

interface Builder {
  id: string;
  title: string;
  status: 'active' | 'archived';
  spec: Record<string, unknown>;
  messages?: { seq: number; role: string; kind: string; text: string }[];
  thinking?: boolean;
}

describe('task builder (E42.1)', () => {
  let owner: Session;
  let other: Session;
  let viewer: Session;
  beforeAll(async () => {
    owner = await login('owner');
    other = await login('other');
    viewer = await login('viewer', 'viewer');
  });

  it('creates a builder with an empty spec, and with a seed posts it as the first owner message', async () => {
    const plain = await call<Builder>(owner, 'POST', '/task-builder', {});
    expect(plain.statusCode).toBe(201);
    expect(plain.data).toMatchObject({ title: '', status: 'active', spec: {} });

    const seeded = await call<Builder>(owner, 'POST', '/task-builder', { seed: 'Pay my water bill every month' });
    expect(seeded.statusCode).toBe(201);
    expect(seeded.data.title).toBe('Pay my water bill every month');
    const read = await call<Builder>(owner, 'GET', `/task-builder/${seeded.data.id}`);
    expect(read.statusCode).toBe(200);
    expect(read.data.messages).toEqual([expect.objectContaining({ seq: 1, role: 'user', kind: 'text', text: 'Pay my water bill every month' })]);

    const row = await prisma.conversation.findUniqueOrThrow({ where: { id: seeded.data.id } });
    expect(row.mode).toBe('task_builder');
    // A builder lists no connection: it never runs anything.
    expect(await prisma.conversationConnection.count({ where: { conversationId: seeded.data.id } })).toBe(0);
    // The turn is queued like a chat's.
    expect(await prisma.job.count({ where: { type: 'chat.turn', subjectId: seeded.data.id } })).toBe(1);
  });

  it('posts a message and queues a turn', async () => {
    const b = await call<Builder>(owner, 'POST', '/task-builder', {});
    const m = await call<{ seq: number; role: string }>(owner, 'POST', `/task-builder/${b.data.id}/messages`, { text: 'Book a tennis court' });
    expect(m.statusCode).toBe(201);
    expect(m.data).toMatchObject({ seq: 1, role: 'user' });
    expect(await prisma.job.count({ where: { type: 'chat.turn', subjectId: b.data.id } })).toBe(1);
  });

  it('changes the spec: merges, clears with null, refuses what does not pass', async () => {
    const b = await call<Builder>(owner, 'POST', '/task-builder', {});
    const url = `/task-builder/${b.data.id}/spec`;
    const first = await call<Record<string, unknown>>(owner, 'PATCH', url, { name: 'Water bill', guardrails: { confirmRiskyActions: true }, schedules: [{ cron: '0 9 1 * *', timezone: 'America/Costa_Rica' }] });
    expect(first.statusCode).toBe(200);
    expect(first.data).toEqual({ name: 'Water bill', guardrails: { confirmRiskyActions: true }, schedules: [{ cron: '0 9 1 * *', timezone: 'America/Costa_Rica' }] });

    const second = await call<Record<string, unknown>>(owner, 'PATCH', url, { name: null, guardrails: { useSavedLogins: true } });
    expect(second.data).toEqual({ guardrails: { confirmRiskyActions: true, useSavedLogins: true }, schedules: [{ cron: '0 9 1 * *', timezone: 'America/Costa_Rica' }] });

    const badCron = await call(owner, 'PATCH', url, { schedules: [{ cron: 'every day', timezone: 'UTC' }] });
    expect(badCron.statusCode).toBe(400);
    const unknownKey = await call(owner, 'PATCH', url, { password: 'hunter2' });
    expect(unknownKey.statusCode).toBe(400);
    const empty = await call(owner, 'PATCH', url, {});
    expect(empty.statusCode).toBe(400);

    // Nothing that failed was written.
    const read = await call<Builder>(owner, 'GET', `/task-builder/${b.data.id}`);
    expect(read.data.spec).toEqual(second.data);
  });

  it('is never a chat in the list, and the chat turn engine leaves it alone', async () => {
    const b = await call<Builder>(owner, 'POST', '/task-builder', { seed: 'Check my miles balance every Monday' });
    const chat = await call<{ id: string }>(owner, 'POST', '/chats', { title: 'A real chat' });
    const list = await call<{ items: { id: string }[] }>(owner, 'GET', '/chats?limit=100');
    const ids = list.data.items.map((i) => i.id);
    expect(ids).toContain(chat.data.id);
    expect(ids).not.toContain(b.data.id);

    const turns = app.get(ChatTurnService, { strict: false });
    await expect(turns.run(b.data.id, owner.userId, null)).resolves.toBe('idle');
    const row = await prisma.conversation.findUniqueOrThrow({ where: { id: b.data.id } });
    expect(row.answeredSeq).toBe(0);
    expect(row.turnLeaseUntil).toBeNull();
    expect(await prisma.chatMessage.count({ where: { conversationId: b.data.id } })).toBe(1);
  });

  it("is the owner's own: another user and a chat id get 404, a viewer gets 403, no session 401", async () => {
    const b = await call<Builder>(owner, 'POST', '/task-builder', {});
    for (const [method, url, payload] of [
      ['GET', `/task-builder/${b.data.id}`, undefined],
      ['POST', `/task-builder/${b.data.id}/messages`, { text: 'hi' }],
      ['PATCH', `/task-builder/${b.data.id}/spec`, { name: 'x' }],
    ] as const) {
      const r = await call(other, method, url, payload);
      expect([method, url, r.statusCode, r.code]).toEqual([method, url, 404, 'TASK_BUILDER_NOT_FOUND']);
    }
    const chat = await call<{ id: string }>(owner, 'POST', '/chats', {});
    expect((await call(owner, 'GET', `/task-builder/${chat.data.id}`)).statusCode).toBe(404);
    expect((await call(viewer, 'POST', '/task-builder', {})).statusCode).toBe(403);
    expect((await call(null, 'POST', '/task-builder', {})).statusCode).toBe(401);
  });

  it('refuses messages and spec changes once archived', async () => {
    const b = await call<Builder>(owner, 'POST', '/task-builder', {});
    await prisma.conversation.update({ where: { id: b.data.id }, data: { status: 'archived' } });
    expect((await call(owner, 'POST', `/task-builder/${b.data.id}/messages`, { text: 'hi' })).code).toBe('TASK_BUILDER_ARCHIVED');
    expect((await call(owner, 'PATCH', `/task-builder/${b.data.id}/spec`, { name: 'x' })).code).toBe('TASK_BUILDER_ARCHIVED');
  });
});
