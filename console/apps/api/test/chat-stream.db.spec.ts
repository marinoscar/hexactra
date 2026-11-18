// The db tier: the chat's live stream (#485) against a real, migrated and
// seeded database: the order of its events, replay from `afterSeq`, the
// pending request without a response, and who may open it.
// (`inject` cannot hold an event stream open: the tests read the controller's observable.)
import type { MessageEvent } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { firstValueFrom, lastValueFrom, take, toArray } from 'rxjs';

import { ChatStreamController, ChatStreamService } from '../src/chat/chat-stream.controller';
import { ChatService } from '../src/chat/chat.service';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
let chats: ChatService;
let stream: ChatStreamController;
let reader: ChatStreamService;
const stamp = `${Date.now()}`;

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
  stream = app.get(ChatStreamController, { strict: false });
  reader = app.get(ChatStreamService, { strict: false });
});
afterAll(async () => {
  await app?.close();
});

type Session = { token: string; userId: string };
async function login(name: string, role: 'contributor' | 'viewer' = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `stream-${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}

/** The first `count` events of the chat's stream. */
const first = (userId: string, id: string, count: number, afterSeq = 0) => lastValueFrom(stream.stream(userId, id, afterSeq).pipe(take(count), toArray()));
const types = (events: MessageEvent[]) => events.map((e) => e.type);
const data = <T>(e: MessageEvent | undefined) => e!.data as T;
const liveRun = (userId: string, conversationId: string, extra: Record<string, unknown> = {}) =>
  prisma.run.create({ data: { userId, conversationId, trigger: 'chat', goal: 'Book two seats', status: 'running', ...extra } as never });
function question(userId: string, runId: string, extra: Record<string, unknown> = {}) {
  return prisma.question.create({
    data: { ownerUserId: userId, askedBy: `run:${runId}`, runId, input: 'confirm', kind: 'confirmation', prompt: 'Place the order for $80?', risk: 'high', confirmLabel: 'Allow', denyLabel: 'Deny', expiresAt: new Date(Date.now() + 3_600_000), ...extra } as never,
  });
}

describe('GET /chats/:id/stream', () => {
  it('sends the chat, its messages in order, then the turn, run and question state', async () => {
    const alice = await login('order');
    const chat = await chats.create(alice.userId, {});
    for (const t of ['Book cinema tickets', 'Two seats', 'Row F']) await chats.postUserMessage(alice.userId, chat.id, t);

    const events = await first(alice.userId, chat.id, 8);
    expect(types(events)).toEqual(['chat', 'message', 'message', 'message', 'turn', 'run', 'question', 'guidance']);
    expect(data(events[0])).toEqual({ title: 'Book cinema tickets', status: 'active' });
    expect(events.slice(1, 4).map((e) => [e.id, data<{ seq: number; text: string }>(e).seq, data<{ text: string }>(e).text])).toEqual([
      ['message-1', 1, 'Book cinema tickets'],
      ['message-2', 2, 'Two seats'],
      ['message-3', 3, 'Row F'],
    ]);
    expect(data(events[4])).toEqual({ thinking: false });
    expect(data(events[5])).toEqual({ run: null });
    expect(data(events[6])).toEqual({ question: null });
    expect(data(events[7])).toEqual({ guidance: [] });
  });

  it('replays only what is newer than afterSeq, and still sends the state', async () => {
    const alice = await login('replay');
    const chat = await chats.create(alice.userId, { title: 'Replay' });
    for (const t of ['one', 'two', 'three']) await chats.postUserMessage(alice.userId, chat.id, t);
    const events = await first(alice.userId, chat.id, 6, 2);
    expect(types(events)).toEqual(['chat', 'message', 'turn', 'run', 'question', 'guidance']);
    expect(data<{ seq: number }>(events[1]).seq).toBe(3);
  });

  it('sends what changes while it is open: a new message, the AI working, a run, its request and the answer', async () => {
    const alice = await login('changes');
    const chat = await chats.create(alice.userId, { title: 'Live' });
    const seen: MessageEvent[] = [];
    const sub = stream.stream(alice.userId, chat.id, 0).subscribe((e) => seen.push(e));
    const until = async (type: string, test: (d: never) => boolean = () => true) => {
      for (let i = 0; i < 60; i += 1) {
        const hit = seen.find((e) => e.type === type && test(e.data as never));
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`no ${type} event; saw ${types(seen).join(', ')}`);
    };
    try {
      await until('question');
      seen.length = 0;

      await chats.postUserMessage(alice.userId, chat.id, 'Buy the stroller');
      await prisma.conversation.update({ where: { id: chat.id }, data: { turnLeaseUntil: new Date(Date.now() + 60_000) } });
      expect(data<{ text: string }>(await until('message')).text).toBe('Buy the stroller');
      await until('turn', (d: { thinking: boolean }) => d.thinking);

      await prisma.conversation.update({ where: { id: chat.id }, data: { turnLeaseUntil: null } });
      const run = await liveRun(alice.userId, chat.id, { activity: { phase: 'acting', action: 'click' }, stepCount: 4 });
      await until('turn', (d: { thinking: boolean }) => !d.thinking);
      const running = data<{ run: Record<string, unknown> }>(await until('run', (d: { run: { id: string } | null }) => d.run?.id === run.id)).run;
      expect(running).toMatchObject({ id: run.id, status: 'running', goal: 'Book two seats', stepCount: 4, activity: { phase: 'acting', action: 'click' }, costUsd: 0, costKnown: true });
      expect(running).not.toHaveProperty('transcript');
      expect(running).not.toHaveProperty('policySnapshot');

      await prisma.run.update({ where: { id: run.id }, data: { status: 'waiting_human' } });
      const q = await question(alice.userId, run.id);
      const asked = data<{ question: Record<string, unknown> }>(await until('question', (d: { question: unknown }) => d.question !== null)).question;
      expect(asked).toMatchObject({ id: q.id, runId: run.id, input: 'confirm', kind: 'confirmation', prompt: 'Place the order for $80?', risk: 'high', confirmLabel: 'Allow', denyLabel: 'Deny', status: 'pending', response: null });

      seen.length = 0;
      await prisma.question.update({ where: { id: q.id }, data: { status: 'answered', response: { outcome: 'answered', value: 'approve', valueWithheld: false } } });
      await prisma.run.update({ where: { id: run.id }, data: { status: 'running' } });
      await until('question', (d: { question: unknown }) => d.question === null);
      expect(JSON.stringify(seen)).not.toContain('approve');

      // Guidance (#490): queued, then read by the agent. The note itself is not sent.
      await prisma.runGuidance.create({ data: { runId: run.id, conversationId: chat.id, messageSeq: 1, note: 'Use the 7:30 showing' } });
      await until('guidance', (d: { guidance: unknown[] }) => d.guidance.length === 1);
      expect(data(seen.filter((e) => e.type === 'guidance').at(-1))).toEqual({ guidance: [{ seq: 1, state: 'queued' }] });
      await prisma.runGuidance.updateMany({ where: { runId: run.id }, data: { deliveredAt: new Date() } });
      await until('guidance', (d: { guidance: Array<{ state: string }> }) => d.guidance[0]?.state === 'delivered');
      // A line the run never read says so once the run has ended.
      await prisma.runGuidance.create({ data: { runId: run.id, conversationId: chat.id, messageSeq: 1, note: 'Too late' } });
      await prisma.run.update({ where: { id: run.id }, data: { status: 'succeeded' } });
      await until('guidance', (d: { guidance: Array<{ state: string }> }) => d.guidance[1]?.state === 'missed');
      expect(JSON.stringify(seen)).not.toContain('7:30 showing');
    } finally {
      sub.unsubscribe();
    }
  }, 30_000);

  it('ends when the chat is deleted', async () => {
    const alice = await login('deleted');
    const chat = await chats.create(alice.userId, { title: 'Short-lived' });
    const done = lastValueFrom(stream.stream(alice.userId, chat.id, 0).pipe(toArray()));
    await new Promise((r) => setTimeout(r, 300));
    await chats.remove(alice.userId, chat.id);
    expect(types(await done)).toEqual(['chat', 'turn', 'run', 'question', 'guidance']);
  });

  it("completes at once, with no event, for another user's chat (the guard answers 404 before that)", async () => {
    const alice = await login('owner');
    const mallory = await login('other');
    const chat = await chats.create(alice.userId, { title: 'Private' });
    await chats.postUserMessage(alice.userId, chat.id, 'secret plans');

    expect(await lastValueFrom(stream.stream(mallory.userId, chat.id, 0).pipe(toArray()))).toEqual([]);
    const res = await app.inject({ method: 'GET', url: `/api/chats/${chat.id}/stream`, headers: { authorization: `Bearer ${mallory.token}` } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('CHAT_NOT_FOUND');
    expect((await app.inject({ method: 'GET', url: `/api/chats/${chat.id}/stream` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/chats/${chat.id}/stream?afterSeq=-1`, headers: { authorization: `Bearer ${alice.token}` } })).statusCode).toBe(400);
  });
});

describe('GET /inbox for a chat run (#488)', () => {
  it("names the chat of a request a chat's run asks, and no chat for any other request", async () => {
    const alice = await login('inbox');
    const chat = await chats.create(alice.userId, { title: 'Sign in' });
    const chatRun = await liveRun(alice.userId, chat.id, { status: 'waiting_human' });
    const other = await prisma.run.create({ data: { userId: alice.userId, goal: 'A scheduled job', status: 'waiting_human', trigger: 'schedule' } });
    const inChat = await question(alice.userId, chatRun.id);
    const elsewhere = await question(alice.userId, other.id);

    const res = await app.inject({ method: 'GET', url: '/api/inbox', headers: { authorization: `Bearer ${alice.token}` } });
    expect(res.statusCode).toBe(200);
    const items = res.json<{ data: Array<{ questionId: string; runId: string; conversationId: string | null }> }>().data;
    expect(items.find((i) => i.questionId === inChat.id)).toMatchObject({ runId: chatRun.id, conversationId: chat.id });
    expect(items.find((i) => i.questionId === elsewhere.id)).toMatchObject({ runId: other.id, conversationId: null });
  });
});

describe('what one look at a chat reads', () => {
  it('never carries a response, and shows a request only while the run waits and the request is pending and unexpired', async () => {
    const alice = await login('snapshot');
    const chat = await chats.create(alice.userId, { title: 'Sign in' });
    const run = await liveRun(alice.userId, chat.id, { status: 'waiting_human' });
    const secret = await question(alice.userId, run.id, { input: 'secret', kind: 'code', prompt: 'Enter the code from your phone', risk: null, confirmLabel: null, denyLabel: null });

    const waiting = await reader.snapshot(alice.userId, chat.id, 0);
    expect(waiting!.question).toMatchObject({ id: secret.id, input: 'secret', kind: 'code', response: null, answeredAt: null });

    // Answered: the request is gone, and nothing of the answer is anywhere in the snapshot.
    await prisma.question.update({ where: { id: secret.id }, data: { status: 'answered', response: { outcome: 'answered', valueWithheld: true }, answeredAt: new Date() } });
    const answered = await reader.snapshot(alice.userId, chat.id, 0);
    expect(answered!.question).toBeNull();
    expect(JSON.stringify(answered)).not.toContain('valueWithheld');

    // Pending but past its expiry: not shown.
    const stale = await question(alice.userId, run.id, { expiresAt: new Date(Date.now() - 1_000) });
    expect((await reader.snapshot(alice.userId, chat.id, 0))!.question).toBeNull();
    // Pending, but the run is not waiting: not shown.
    await prisma.question.update({ where: { id: stale.id }, data: { expiresAt: new Date(Date.now() + 60_000) } });
    await prisma.run.update({ where: { id: run.id }, data: { status: 'running' } });
    expect((await reader.snapshot(alice.userId, chat.id, 0))!.question).toBeNull();
  });

  it('shows the newest run of the chat, finished or not, and nothing of another user', async () => {
    const alice = await login('newest');
    const mallory = await login('newest-other');
    const chat = await chats.create(alice.userId, { title: 'Runs' });
    await liveRun(alice.userId, chat.id, { status: 'failed', error: 'old', createdAt: new Date(Date.now() - 60_000) });
    const newest = await liveRun(alice.userId, chat.id, { status: 'succeeded', result: 'The fare is 84 EUR.', stopReason: 'finished' });
    expect((await reader.snapshot(alice.userId, chat.id, 0))!.run).toMatchObject({ id: newest.id, status: 'succeeded', result: 'The fare is 84 EUR.', stopReason: 'finished' });
    expect(await reader.snapshot(mallory.userId, chat.id, 0)).toBeNull();
    expect(await firstValueFrom(stream.stream(mallory.userId, chat.id, 0).pipe(toArray()))).toEqual([]);
  });
});
