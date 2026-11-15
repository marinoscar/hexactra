// The question channels (#289) against a real database: a new channel plugs
// in with no broker change (a test-only `fake-chat`), the questions.asked
// notification and its withdrawal, quick answers from a notification, the
// webhook answer token (once, replay, wrong question, expired, high-risk
// confirm), and single use held in the database across two token services.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { NotificationsService } from '@marinoscar/platform-api/notifications';

import { createApp } from '../src/main';
import { QUESTION_ASKED_EVENT } from '../src/platform/notifications/hexactra.notifications';
import { PrismaService } from '../src/prisma/prisma.service';
import { NotificationsQuestionChannel } from '../src/questions/channels/notifications.channel';
import { QuestionChannelRegistry, type QuestionChannel, type QuestionChannelContext } from '../src/questions/channels/question-channel';
import { QuestionChannelDispatcher, QuestionsDeliverHandler, type QuestionDeliverPayload } from '../src/questions/channels/question-dispatcher';
import { WebhookQuestionChannel } from '../src/questions/channels/webhook.channel';
import { QuestionsService, type QuestionView } from '../src/questions/questions.service';
import { ActionTokenStore } from '../src/tasks/action-token-store';
import { RunActionTokens } from '../src/tasks/run-action-token';

let app: NestFastifyApplication;
let prisma: PrismaService;
let questions: QuestionsService;
let handler: QuestionsDeliverHandler;
let notificationsChannel: NotificationsQuestionChannel;

/** The jobs the dispatcher queued (the queue, in memory: each test runs them). */
const jobs: QuestionDeliverPayload[] = [];
/** What the webhook channel emitted. */
const emitted: { userId: string; key: string; data: Record<string, unknown> }[] = [];
const fabricCalls: [string, string, unknown][] = [];
const fabric = {
  request: jest.fn(async (method: string, path: string, opts: { body?: unknown } = {}) => {
    fabricCalls.push([method, path, opts.body]);
    return {};
  }),
};

/** A chat app, registered by a test: no broker change needed. */
const chat: { delivered: string[]; withdrawn: { id: string; ctx: QuestionChannelContext }[] } = { delivered: [], withdrawn: [] };
const fakeChat: QuestionChannel = {
  id: 'fake-chat',
  canCollect: () => true,
  deliver: async (q) => void chat.delivered.push(q.id),
  withdraw: async (q, ctx) => void chat.withdrawn.push({ id: q.id, ctx }),
};

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  questions = app.get(QuestionsService, { strict: false });
  handler = app.get(QuestionsDeliverHandler, { strict: false });
  notificationsChannel = app.get(NotificationsQuestionChannel, { strict: false });
  Object.assign(questions, { fabric, jobs: { enqueue: async () => undefined } });
  Object.assign(app.get(QuestionChannelDispatcher, { strict: false }), { jobs: { enqueue: async (j: { payload: QuestionDeliverPayload }) => void jobs.push(j.payload) } });
  Object.assign(app.get(WebhookQuestionChannel, { strict: false }), {
    webhooks: { emitForUser: async (userId: string, key: string, data: Record<string, unknown>) => void emitted.push({ userId, key, data }) },
  });
  app.get(QuestionChannelRegistry, { strict: false }).register(fakeChat);
});
afterAll(async () => {
  await app?.close();
});

async function login(email: string): Promise<{ token: string; userId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
const as = (token: string) => ({ authorization: `Bearer ${token}` });

async function until<T>(fn: () => T | undefined, ms = 5_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Run the queued job of `op` for `id` (as the worker would). */
async function runJob(id: string, op: 'deliver' | 'withdraw'): Promise<QuestionDeliverPayload> {
  const job = await until(() => jobs.find((j) => j.questionId === id && j.op === op));
  await handler.run(job);
  return job;
}

async function ask(token: string, body: Record<string, unknown>): Promise<QuestionView> {
  const res = await app.inject({ method: 'POST', url: '/api/questions', headers: as(token), payload: body });
  expect(res.statusCode).toBe(201);
  const q = res.json<{ data: QuestionView }>().data;
  await runJob(q.id, 'deliver');
  return q;
}

const byToken = (id: string, token: string | undefined, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/questions/${id}/answer-by-token`, headers: token === undefined ? {} : { 'x-question-token': token }, payload });
const askedOf = (id: string) => emitted.find((e) => e.key === 'questions.question.asked' && (e.data.question as { id: string }).id === id);
const tokenOf = (id: string) => (askedOf(id)!.data.answer as { token: string } | undefined)?.token;

describe('question channels', () => {
  it('a new channel plugs in with no broker change: delivered, answered on it, withdrawn', async () => {
    const u = await login(`qc-chat-${Date.now()}@example.test`);
    const q = await ask(u.token, { input: 'choice', prompt: 'Which fare?', options: ['early', 'late', 'none'] });
    expect(chat.delivered).toContain(q.id);
    await questions.answer({ id: u.userId }, q.id, { outcome: 'completed', value: 'late' }, { channel: 'fake-chat' });
    await runJob(q.id, 'withdraw');
    expect(chat.withdrawn).toContainEqual({ id: q.id, ctx: { ownerUserId: u.userId, event: 'question.answered', answeredChannel: 'fake-chat' } });
    const answered = emitted.find((e) => e.key === 'questions.question.answered' && (e.data.question as { id: string }).id === q.id)!;
    expect(answered.data).toMatchObject({ status: 'answered', outcome: 'completed', value: 'late', channel: 'fake-chat' });
  });

  it('a free-standing question is notified as questions.asked with a deep link, and withdrawn when answered', async () => {
    const u = await login(`qc-notify-${Date.now()}@example.test`);
    const q = await ask(u.token, { input: 'text', prompt: 'Name the trip' });
    await app.get(NotificationsService, { strict: false }).flush();
    const row = await prisma.notification.findFirstOrThrow({ where: { userId: u.userId, eventKey: QUESTION_ASKED_EVENT } });
    expect(row).toMatchObject({ title: 'A question for you', body: 'Name the trip', link: `/inbox/q/${q.id}`, dismissedAt: null });
    await questions.answer({ id: u.userId }, q.id, { outcome: 'completed', value: 'Spring' }, { channel: 'web' });
    await runJob(q.id, 'withdraw');
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: row.id } })).dismissedAt).not.toBeNull();
  });

  it('a question of a browser run is not notified twice (runs.needs_you covers it); a secret gets no webhook token', async () => {
    const u = await login(`qc-run-${Date.now()}@example.test`);
    const run = await prisma.run.create({ data: { userId: u.userId, goal: 'Sign in', trigger: 'external', status: 'waiting_human', sessionId: randomUUID(), startedAt: new Date() } });
    const q = await questions.mirrorHandoff({ id: u.userId }, questions.parseSpec({ input: 'secret', kind: 'code', prompt: 'Enter the code' }), { id: randomUUID(), viewerUrl: null, pageTitle: null, expiresAt: null }, { askedBy: 'agent:test', runId: run.id, fabricSessionId: run.sessionId });
    await runJob(q.id, 'deliver');
    await app.get(NotificationsService, { strict: false }).flush();
    expect(await prisma.notification.count({ where: { userId: u.userId, eventKey: QUESTION_ASKED_EVENT } })).toBe(0);
    expect(askedOf(q.id)!.data.answer).toBeUndefined();
  });

  it('a notification quick answer answers once, on the notification channel', async () => {
    const u = await login(`qc-quick-${Date.now()}@example.test`);
    const q = await ask(u.token, { input: 'confirm', risk: 'low', prompt: 'Book the 9:00 table?' });
    const { actionToken } = notificationsChannel.payload(q, u.userId) as { actionToken: string };
    const act = () => app.inject({ method: 'POST', url: '/api/notification-actions', payload: { token: actionToken, action: 'answer-0' } });
    expect((await act()).statusCode).toBe(200);
    const done = await questions.get(u.userId, q.id);
    expect(done).toMatchObject({ status: 'answered', response: { outcome: 'completed', value: 'approve', channel: 'notification' } });
    expect((await act()).statusCode).toBe(401);
    // A high-risk confirm gets no button at all.
    const high = await ask(u.token, { input: 'confirm', risk: 'high', prompt: 'Pay 120?' });
    expect(notificationsChannel.payload(high, u.userId).actionToken).toBeUndefined();
  });

  it('a webhook token answers once; replay, wrong question, expired, missing and high-risk are refused', async () => {
    const u = await login(`qc-hook-${Date.now()}@example.test`);
    const a = await ask(u.token, { input: 'number', prompt: 'How many seats?', constraints: { min: 1, max: 9 } });
    const b = await ask(u.token, { input: 'text', prompt: 'Any note?' });
    const ta = tokenOf(a.id)!;
    expect(askedOf(a.id)!.data.answer).toMatchObject({ method: 'POST', tokenHeader: 'x-question-token', url: expect.stringMatching(new RegExp(`/api/questions/${a.id}/answer-by-token$`)) });
    // Stored only as sha256.
    expect(await prisma.actionToken.count({ where: { tokenHash: ta } })).toBe(0);

    expect((await byToken(a.id, undefined, { value: '2' })).statusCode).toBe(401);
    expect((await byToken(b.id, ta, { value: '2' })).statusCode).toBe(401); // wrong question
    expect((await byToken(a.id, ta, { value: '42' })).statusCode).toBe(400); // invalid: the token is not spent
    const ok = await byToken(a.id, ta, { value: '2' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ data: QuestionView }>().data).toMatchObject({ status: 'answered', response: { value: '2', channel: 'webhook' } });
    expect((await byToken(a.id, ta, { value: '3' })).statusCode).toBe(409); // replay

    // Expired with the question.
    const tb = tokenOf(b.id)!;
    await prisma.actionToken.updateMany({ where: { questionId: b.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await byToken(b.id, tb, { value: 'late' })).statusCode).toBe(401);

    // A high-risk confirm is delivered without a token; a token for it (forged into the store) is refused.
    const high = await ask(u.token, { input: 'confirm', risk: 'high', prompt: 'Pay 120?' });
    expect(askedOf(high.id)!.data.answer).toBeUndefined();
    const forged = (await app.get(ActionTokenStore, { strict: false }).issue('question-webhook', { expiresAt: new Date(high.expiresAt), questionId: high.id }))!;
    expect((await byToken(high.id, forged, { value: 'approve' })).statusCode).toBe(403);
    expect((await questions.get(u.userId, high.id)).status).toBe('pending');
  });

  it('a webhook token is issued once per question', async () => {
    const u = await login(`qc-once-${Date.now()}@example.test`);
    const q = await ask(u.token, { input: 'text', prompt: 'Once?' });
    const before = emitted.length;
    await handler.run({ questionId: q.id, op: 'deliver', event: 'question.asked', answeredChannel: null });
    expect(emitted.length).toBe(before);
    expect(await prisma.actionToken.count({ where: { questionId: q.id } })).toBe(1);
  });

  it('single use holds across two API instances (the nonce is spent in the database)', async () => {
    const u = await login(`qc-two-${Date.now()}@example.test`);
    const q = await ask(u.token, { input: 'choice', prompt: 'Window or aisle?', options: ['window', 'aisle'] });
    const one = new RunActionTokens(new ActionTokenStore(prisma));
    const two = new RunActionTokens(new ActionTokenStore(prisma));
    const token = one.issueQuestion(u.userId, q.id, ['window', 'aisle'], new Date(q.expiresAt));
    expect(await one.redeemQuestion(token, 'answer-1')).toMatchObject({ value: 'aisle' });
    expect(await two.redeemQuestion(token, 'answer-1')).toBeNull();
    const run = one.issue(u.userId, randomUUID(), null);
    expect(await two.redeem(run, 'cancel')).not.toBeNull();
    expect(await one.redeem(run, 'cancel')).toBeNull();
  });

  it('an expired question is withdrawn on every channel', async () => {
    const u = await login(`qc-exp-${Date.now()}@example.test`);
    const q = await ask(u.token, { input: 'text', prompt: 'Too late?' });
    await prisma.question.update({ where: { id: q.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await questions.expireDue({ id: q.id });
    await runJob(q.id, 'withdraw');
    expect(chat.withdrawn.find((w) => w.id === q.id)?.ctx.event).toBe('question.expired');
    expect(emitted.find((e) => e.key === 'questions.question.expired' && (e.data.question as { id: string }).id === q.id)!.data).toEqual({
      question: { id: q.id, input: 'text', kind: 'other', runId: null },
      status: 'expired',
    });
    // The webhook token of an expired question no longer answers.
    expect((await byToken(q.id, tokenOf(q.id), { value: 'x' })).statusCode).toBe(409);
  });
});
