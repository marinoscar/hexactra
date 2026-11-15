// The buttons of a "needs you" notification against a real database: the
// token the notifier issues approves that one plain confirmation or stops
// that one run, once, without a session; nothing else is possible with it.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { HandoffAnswers } from '../src/browser/handoff-answers';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { RunActionTokens } from '../src/tasks/run-action-token';
import { TasksService } from '../src/tasks/tasks.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
let tokens: RunActionTokens;
const calls: [string, string, unknown][] = [];
const fabric = {
  request: jest.fn(async (method: string, path: string, opts: { body?: unknown } = {}) => {
    calls.push([method, path, opts.body]);
    return {};
  }),
};

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  tokens = app.get(RunActionTokens, { strict: false });
  // The fabric, in memory: the services talk to it through `request`.
  Object.assign(app.get(HandoffAnswers, { strict: false }), { fabric });
  Object.assign(app.get(TasksService, { strict: false }), { fabric });
});
afterAll(async () => {
  await app?.close();
});

async function user(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return me.json<{ data: { id: string } }>().data.id;
}

async function waitingRun(userId: string, handoffId: string) {
  // trigger `external`: the answer resumes nothing here (the external agent polls its handoff).
  return prisma.run.create({
    data: { userId, goal: 'Book a table', trigger: 'external', status: 'waiting_human', handoffId, sessionId: '00000000-0000-4000-8000-0000000000aa', startedAt: new Date() },
  });
}

const act = (token: string, action: string) => app.inject({ method: 'POST', url: '/api/notification-actions', payload: { token, action } });

describe('notification buttons (POST /api/notification-actions)', () => {
  const H1 = '00000000-0000-4000-8000-0000000000b1';
  const H2 = '00000000-0000-4000-8000-0000000000b2';

  it('Approve answers that confirmation once, without a session', async () => {
    const uid = await user(`na-${Date.now()}@example.test`);
    const run = await waitingRun(uid, H1);
    const token = tokens.issue(uid, run.id, H1);
    const res = await act(token, 'approve');
    expect(res.statusCode).toBe(200);
    expect(calls).toContainEqual(['POST', `/v1/handoffs/${H1}/respond`, { outcome: 'completed' }]);
    // Used once: the same button does nothing again.
    expect((await act(token, 'approve')).statusCode).toBe(401);
  });

  it('Stop run cancels a waiting run at once and withdraws its request', async () => {
    const uid = await user(`na-stop-${Date.now()}@example.test`);
    const run = await waitingRun(uid, H2);
    const res = await act(tokens.issue(uid, run.id, null), 'cancel');
    expect(res.statusCode).toBe(200);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'cancelled', error: 'Cancelled by the user' });
    expect(calls).toContainEqual(['POST', `/v1/handoffs/${H2}/cancel`, undefined]);
    expect(calls).toContainEqual(['DELETE', '/v1/sessions/00000000-0000-4000-8000-0000000000aa', undefined]);
  });

  it('a cancel-only token cannot approve; forged, expired and stale buttons are refused', async () => {
    const uid = await user(`na-no-${Date.now()}@example.test`);
    const run = await waitingRun(uid, H1);
    expect((await act(tokens.issue(uid, run.id, null), 'approve')).statusCode).toBe(401);
    const good = tokens.issue(uid, run.id, H1);
    expect((await act(`${good.split('.')[0]}.forged`, 'approve')).statusCode).toBe(401);
    expect((await act(tokens.issue(uid, run.id, H1, Date.now() - 2 * 3600_000), 'approve')).statusCode).toBe(401);
    // The run moved on to another request: the old button must not answer it.
    const stale = tokens.issue(uid, run.id, '00000000-0000-4000-8000-0000000000ff');
    expect((await act(stale, 'approve')).statusCode).toBe(409);
  });
});
