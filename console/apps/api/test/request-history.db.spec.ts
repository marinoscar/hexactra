// E40.4 (#688) against a real database: the `questions` system settings
// (admin only, defaults 7 days and 60 minutes), the nightly purge of request
// history (settled and old only, with its chat record; never a pending one),
// and the default wait applied to a question with no time of its own.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { QuestionsService } from '../src/questions/questions.service';
import { REQUEST_HISTORY_AUDIT_ACTION, RequestHistoryRetentionHandler } from '../src/questions/request-history.jobs';

let app: NestFastifyApplication;
let prisma: PrismaService;
let questions: QuestionsService;
let handler: RequestHistoryRetentionHandler;
const stamp = `${Date.now()}`;
const DAY = 24 * 3600_000;

const workerMode = process.env.JOBS_WORKER_MODE;
beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
  prisma = app.get(PrismaService);
  questions = app.get(QuestionsService, { strict: false });
  handler = app.get(RequestHistoryRetentionHandler, { strict: false });
});
afterAll(async () => {
  await app?.close();
});

type Session = { token: string; userId: string };
async function login(name: string, role: 'contributor' | 'admin' = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `rh-${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
async function call<T = unknown>(s: Session, method: 'GET' | 'PATCH', url: string, payload?: unknown): Promise<{ statusCode: number; data: T }> {
  const res = await app.inject({ method, url: `/api${url}`, headers: { authorization: `Bearer ${s.token}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { statusCode: res.statusCode, data: (res.body ? res.json<{ data?: T }>().data : undefined) as T };
}
const setQuestions = async (admin: Session, patch: Record<string, number>) => expect((await call(admin, 'PATCH', '/system-settings', { questions: patch })).statusCode).toBe(200);

describe('request history settings (E40.4)', () => {
  let admin: Session;
  beforeAll(async () => {
    admin = await login('admin', 'admin');
  });
  afterEach(() => setQuestions(admin, { historyKeepDays: 7, defaultWaitMinutes: 60 }));

  it('defaults to 7 days and 60 minutes, and only an administrator may change them', async () => {
    const doc = await call<{ questions: { historyKeepDays: number; defaultWaitMinutes: number } }>(admin, 'GET', '/system-settings');
    expect(doc.data.questions).toEqual({ historyKeepDays: 7, defaultWaitMinutes: 60 });
    const user = await login('user');
    expect((await call(user, 'PATCH', '/system-settings', { questions: { historyKeepDays: 1 } })).statusCode).toBe(403);
    expect((await call(admin, 'PATCH', '/system-settings', { questions: { historyKeepDays: 0 } })).statusCode).toBe(400);
    expect((await call(admin, 'PATCH', '/system-settings', { questions: { defaultWaitMinutes: 1441 } })).statusCode).toBe(400);
  });

  it('deletes settled history older than the limit with its chat record, and keeps pending and recent requests', async () => {
    const owner = await login('owner');
    const conv = await prisma.conversation.create({ data: { userId: owner.userId, title: 'History' } });
    const run = await prisma.forUser({ userId: owner.userId }).run.create({ data: { userId: owner.userId, conversationId: conv.id, trigger: 'chat', origin: 'web', goal: 'Pick', status: 'waiting_human' } });
    const ask = (prompt: string) => questions.create({ id: owner.userId }, questions.parseSpec({ input: 'text', prompt }), { askedBy: `run:${run.id}`, runId: run.id });
    const oldAnswered = await ask('Old answered');
    const oldExpired = await ask('Old expired');
    const recent = await ask('Recent answered');
    const pending = await ask('Still waiting');
    await prisma.question.update({ where: { id: oldAnswered.id }, data: { status: 'answered', answeredAt: new Date(Date.now() - 10 * DAY), response: { outcome: 'completed', valueWithheld: false } } });
    await prisma.question.update({ where: { id: oldExpired.id }, data: { status: 'expired', expiresAt: new Date(Date.now() - 9 * DAY) } });
    await prisma.question.update({ where: { id: recent.id }, data: { status: 'answered', answeredAt: new Date(Date.now() - 2 * DAY) } });
    await prisma.question.update({ where: { id: pending.id }, data: { createdAt: new Date(Date.now() - 30 * DAY), expiresAt: new Date(Date.now() + DAY) } });
    const step = await prisma.runStep.create({ data: { runId: run.id, seq: 1, kind: 'handoff', action: 'answered', ok: true, summary: 'The owner answered', questionId: oldAnswered.id } });
    expect(await prisma.chatMessage.count({ where: { conversationId: conv.id, kind: 'request' } })).toBe(4);

    const totals = await handler.purge(`test-job-${stamp}`);
    expect(totals.keepDays).toBe(7);
    const left = new Set((await prisma.question.findMany({ where: { runId: run.id }, select: { id: true } })).map((q) => q.id));
    expect(left).toEqual(new Set([recent.id, pending.id]));
    const records = await prisma.chatMessage.findMany({ where: { conversationId: conv.id, kind: 'request' } });
    expect(records.map((m) => (m.meta as { questionId: string }).questionId).sort()).toEqual([recent.id, pending.id].sort());
    // The run keeps its step: the summary stays, the link is cleared.
    expect(await prisma.runStep.findUniqueOrThrow({ where: { id: step.id } })).toMatchObject({ summary: 'The owner answered', questionId: null });
    expect(await prisma.auditEvent.count({ where: { action: REQUEST_HISTORY_AUDIT_ACTION, targetId: `test-job-${stamp}` } })).toBe(1);

    // A shorter limit, set by an administrator, takes the recent one too; a pending one stays.
    await setQuestions(admin, { historyKeepDays: 1 });
    await handler.purge(`test-job-2-${stamp}`);
    expect((await prisma.question.findMany({ where: { runId: run.id }, select: { id: true } })).map((q) => q.id)).toEqual([pending.id]);
  });

  it('a question with no time of its own waits the default; an explicit time wins', async () => {
    const owner = await login('wait');
    const near = (at: string, ms: number) => Math.abs(Date.parse(at) - (Date.now() + ms)) < 30_000;
    const byDefault = await questions.create({ id: owner.userId }, questions.parseSpec({ input: 'text', prompt: 'Default wait?' }), { askedBy: 'agent:x' });
    expect(near(byDefault.expiresAt, 60 * 60_000)).toBe(true);
    await setQuestions(admin, { defaultWaitMinutes: 240 });
    const longer = await questions.create({ id: owner.userId }, questions.parseSpec({ input: 'text', prompt: 'Four hours?' }), { askedBy: 'agent:x' });
    expect(near(longer.expiresAt, 240 * 60_000)).toBe(true);
    const own = await questions.create({ id: owner.userId }, questions.parseSpec({ input: 'text', prompt: 'Own time', timeoutMs: 120_000 }), { askedBy: 'agent:x' });
    expect(near(own.expiresAt, 120_000)).toBe(true);
  });
});
