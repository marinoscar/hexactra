// The question broker (#288) against a real database, with an in-memory
// fabric: free-standing questions end to end over REST, first answer wins,
// owner-only access, secrets never stored, expiry, the long-poll, and a run's
// handoff answered through the broker resuming the run.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';
import type { Job } from '@marinoscar/platform-api/jobs';

import { createApp } from '../src/main';
import type { FabricClient } from '../src/fabric/fabric.client';
import { PrismaService } from '../src/prisma/prisma.service';
import { QuestionEvents, type QuestionEvent } from '../src/questions/question-events';
import { QuestionsExpireHandler } from '../src/questions/questions.jobs';
import { QuestionsService } from '../src/questions/questions.service';
import { GoalRunnerService } from '../src/runner/goal-runner.service';
import { TasksService } from '../src/tasks/tasks.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
let questions: QuestionsService;
const stamp = `${Date.now()}`;
const SECRET = '424242';

/** The fabric, in memory: handoffs with the real view shape, and every call made. */
const calls: [string, string, Record<string, unknown> | undefined][] = [];
const handoffs = new Map<string, { id: string; status: string; input: string; kind: string; prompt: string; choices: unknown[]; response?: Record<string, unknown> }>();
const fabric = {
  request: jest.fn(async (method: string, path: string, opts: { body?: Record<string, unknown> } = {}) => {
    calls.push([method, path, opts.body]);
    if (method === 'POST' && path === '/v1/sessions') return { id: randomUUID() };
    if (method === 'DELETE' && path.startsWith('/v1/sessions/')) return undefined;
    if (method === 'POST' && path.endsWith('/actions')) return { id: 'op', state: 'succeeded', result: {} };
    if (method === 'POST' && path.endsWith('/handoffs')) {
      const id = randomUUID();
      const b = opts.body!;
      handoffs.set(id, { id, status: 'pending', input: String(b.input), kind: String(b.kind), prompt: String(b.prompt), choices: (b.choices as unknown[]) ?? [] });
      return { handoff: { ...handoffs.get(id), viewer_url: `https://viewer.example.test/${id}`, page: { title: 'Shop' }, expires_at: new Date(Date.now() + 600_000).toISOString() } };
    }
    const id = path.split('/')[3]!;
    if (method === 'GET' && path.startsWith('/v1/handoffs/')) return handoffs.get(id);
    if (method === 'POST' && path.endsWith('/respond')) {
      const h = handoffs.get(id);
      if (h) {
        const b = opts.body!;
        h.status = b.outcome === 'cancelled' ? 'cancelled' : 'completed';
        h.response = { outcome: b.outcome, ...(h.input === 'secret' ? {} : { value: b.value, values: b.values }), value_withheld: h.input === 'secret', channel: b.channel, by: b.answered_by, answered_at: new Date().toISOString() };
      }
      return {};
    }
    if (method === 'POST' && path.endsWith('/cancel')) return {};
    throw new Error(`unexpected ${method} ${path}`);
  }),
  config: async () => ({ url: 'http://fabric.example.test', token: 't' }),
};
/** Runs the broker resumed (the queue, in memory). */
const enqueued: { type: string; subjectId: string }[] = [];

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  questions = app.get(QuestionsService, { strict: false });
  Object.assign(questions, { fabric, jobs: { enqueue: async (j: { type: string; subjectId: string }) => void enqueued.push(j) } });
});
afterAll(async () => {
  await app?.close();
});

async function login(email: string, role: 'contributor' | 'viewer' = 'contributor'): Promise<{ token: string; userId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
const as = (token: string) => ({ authorization: `Bearer ${token}` });
const data = <T,>(res: { json: <U>() => U }): T => res.json<{ data: T }>().data;
type View = { id: string; status: string; input: string; options: { id: string; label: string }[] | null; response: Record<string, unknown> | null; askedBy: string };

describe('free-standing questions over REST', () => {
  it('asks, lists, answers once and shows the answer; the inbox lists it while pending', async () => {
    const a = await login(`q-alice-${stamp}@example.test`);
    const created = await app.inject({
      method: 'POST',
      url: '/api/questions',
      headers: as(a.token),
      payload: { input: 'choice', prompt: 'Which seat?', choices: ['Aisle', { id: 'win', label: 'Window', description: 'Left side' }], asker: 'agent-x' },
    });
    expect(created.statusCode).toBe(201);
    const q = data<View>(created);
    expect(q).toMatchObject({ status: 'pending', input: 'choice', askedBy: 'agent:agent-x', options: [{ id: 'Aisle', label: 'Aisle' }, { id: 'win', label: 'Window', description: 'Left side' }] });

    const inbox = data<{ questionId: string; runId: string | null; choices: string[] }[]>(await app.inject({ method: 'GET', url: '/api/inbox', headers: as(a.token) }));
    expect(inbox).toEqual([expect.objectContaining({ questionId: q.id, runId: null, choices: ['Aisle', 'win'] })]);
    expect(data<View[]>(await app.inject({ method: 'GET', url: '/api/questions?status=pending', headers: as(a.token) })).map((x) => x.id)).toEqual([q.id]);

    expect((await app.inject({ method: 'POST', url: `/api/questions/${q.id}/answer`, headers: as(a.token), payload: { value: 'Middle' } })).statusCode).toBe(400);
    const answered = await app.inject({ method: 'POST', url: `/api/questions/${q.id}/answer`, headers: as(a.token), payload: { value: 'win', channel: 'web' } });
    expect(answered.statusCode).toBe(200);
    expect(data<View>(answered)).toMatchObject({ status: 'answered', response: { outcome: 'completed', value: 'win', valueWithheld: false, channel: 'web', by: `user:${a.userId}` } });
    expect((await app.inject({ method: 'POST', url: `/api/questions/${q.id}/answer`, headers: as(a.token), payload: { value: 'Aisle' } })).statusCode).toBe(409);
    expect(data<View>(await app.inject({ method: 'GET', url: `/api/questions/${q.id}`, headers: as(a.token) }))).toMatchObject({ status: 'answered' });
    expect(data<unknown[]>(await app.inject({ method: 'GET', url: '/api/inbox', headers: as(a.token) }))).toEqual([]);
  });

  it('is owner-only, and a viewer cannot ask or answer', async () => {
    const a = await login(`q-own-${stamp}@example.test`);
    const b = await login(`q-other-${stamp}@example.test`);
    const v = await login(`q-viewer-${stamp}@example.test`, 'viewer');
    const q = data<View>(await app.inject({ method: 'POST', url: '/api/questions', headers: as(a.token), payload: { input: 'text', prompt: 'Your name?' } }));
    expect((await app.inject({ method: 'GET', url: `/api/questions/${q.id}`, headers: as(b.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/questions/${q.id}/answer`, headers: as(b.token), payload: { value: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/questions/${q.id}/cancel`, headers: as(b.token), payload: {} })).statusCode).toBe(404);
    expect(data<View[]>(await app.inject({ method: 'GET', url: '/api/questions', headers: as(b.token) })).map((x) => x.id)).not.toContain(q.id);
    expect((await app.inject({ method: 'POST', url: '/api/questions', headers: as(v.token), payload: { input: 'none', prompt: 'x' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/questions' })).statusCode).toBe(401);
    // The owner declines it.
    expect(data<View>(await app.inject({ method: 'POST', url: `/api/questions/${q.id}/cancel`, headers: as(a.token) }))).toMatchObject({ status: 'cancelled', response: { outcome: 'cancelled' } });
  });

  it('lets exactly one of several concurrent answers win', async () => {
    const a = await login(`q-race-${stamp}@example.test`);
    const q = data<View>(await app.inject({ method: 'POST', url: '/api/questions', headers: as(a.token), payload: { input: 'number', prompt: 'How many?', constraints: { min: 1, max: 9 } } }));
    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) => app.inject({ method: 'POST', url: `/api/questions/${q.id}/answer`, headers: as(a.token), payload: { value: n } })),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409, 409, 409, 409]);
    const row = await prisma.question.findUniqueOrThrow({ where: { id: q.id } });
    const winner = data<View>(results.find((r) => r.statusCode === 200)!);
    expect(row.status).toBe('answered');
    expect((row.response as { value: string }).value).toBe(winner.response!.value);
  });

  it('validates every input type when asking and answering', async () => {
    const a = await login(`q-valid-${stamp}@example.test`);
    const ask = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/questions', headers: as(a.token), payload });
    const answer = (id: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/questions/${id}/answer`, headers: as(a.token), payload });

    // Bad questions.
    const secret = await ask({ input: 'secret', prompt: 'Password?' });
    expect([secret.statusCode, secret.json<{ message: string }>().message]).toEqual([400, expect.stringMatching(/browser session/)]);
    expect((await ask({ input: 'choice', prompt: 'Pick' })).statusCode).toBe(400);
    expect((await ask({ input: 'text', prompt: 'x', choices: ['a'] })).statusCode).toBe(400);
    expect((await ask({ input: 'text', prompt: 'x', constraints: { pattern: '(' } })).statusCode).toBe(400);
    expect((await ask({ input: 'number', prompt: 'x', constraints: { maxLength: 3 } })).statusCode).toBe(400);
    expect((await ask({ input: 'multi_choice', prompt: 'x', options: ['a', 'b'], constraints: { maxSelections: 3 } })).statusCode).toBe(400);
    expect((await ask({ input: 'none', prompt: 'x', confirmLabel: 'Yes' })).statusCode).toBe(400);
    expect((await ask({ input: 'choice', prompt: 'x', options: [{ id: 'bad id!', label: 'A' }] })).statusCode).toBe(400);
    expect((await ask({ input: 'warp', prompt: 'x' })).statusCode).toBe(400);

    const cases: [Record<string, unknown>, Record<string, unknown>[], Record<string, unknown>, Record<string, unknown>][] = [
      [{ input: 'text', prompt: 'Zip', constraints: { pattern: '\\d{5}', multiline: false } }, [{ value: '1234' }, { value: '12345\n' }, {}], { value: '12345' }, { value: '12345' }],
      [{ input: 'multi_choice', prompt: 'Toppings', options: ['ham', 'egg', 'kale'], constraints: { minSelections: 1, maxSelections: 2 } }, [{ values: ['ham', 'egg', 'kale'] }, { values: ['ham', 'ham'] }, { values: ['tofu'] }, { value: 'ham' }], { values: ['kale', 'ham'] }, { values: ['kale', 'ham'] }],
      [{ input: 'number', prompt: 'Guests', constraints: { min: 1, max: 10, step: 0.5, unit: 'people' } }, [{ value: '0' }, { value: '1.25' }, { value: 'ten' }], { value: '02.50' }, { value: '2.5' }],
      [{ input: 'confirm', prompt: 'Pay?', confirmLabel: 'Pay', denyLabel: 'Stop', risk: 'low' }, [{ value: 'yes' }, {}], { value: 'deny' }, { value: 'deny' }],
      [{ input: 'none', prompt: 'Tap done' }, [{ value: 'x' }], {}, {}],
      [{ input: 'takeover', prompt: 'Drive it' }, [{ value: 'x' }], {}, {}],
    ];
    for (const [question, bad, good, stored] of cases) {
      const created = await ask(question);
      expect(created.statusCode).toBe(201);
      const q = data<View & { risk: string | null }>(created);
      if (question.input === 'confirm') expect(q).toMatchObject({ risk: 'low', confirmLabel: 'Pay', denyLabel: 'Stop' });
      for (const b of bad) expect([question.input, b, (await answer(q.id, b)).statusCode]).toEqual([question.input, b, 400]);
      const ok = await answer(q.id, good);
      expect([question.input, ok.statusCode]).toEqual([question.input, 200]);
      expect(data<View>(ok).response).toMatchObject({ outcome: 'completed', ...stored, valueWithheld: false });
    }
  });

  it('holds a long-poll until the answer arrives, and emits the events', async () => {
    const a = await login(`q-wait-${stamp}@example.test`);
    const seen: QuestionEvent[] = [];
    const off = app.get(QuestionEvents, { strict: false }).subscribe((e) => void seen.push(e));
    const q = data<View>(await app.inject({ method: 'POST', url: '/api/questions', headers: as(a.token), payload: { input: 'text', prompt: 'Code word?' } }));
    const started = Date.now();
    const waiting = app.inject({ method: 'GET', url: `/api/questions/${q.id}?waitMs=10000`, headers: as(a.token) });
    setTimeout(() => void app.inject({ method: 'POST', url: `/api/questions/${q.id}/answer`, headers: as(a.token), payload: { value: 'pelican' } }), 300);
    const res = await waiting;
    expect(data<View>(res)).toMatchObject({ status: 'answered', response: { value: 'pelican' } });
    expect(Date.now() - started).toBeLessThan(5_000);
    // A short wait on an unanswered question returns it pending.
    const q2 = data<View>(await app.inject({ method: 'POST', url: '/api/questions', headers: as(a.token), payload: { input: 'none', prompt: 'Later' } }));
    expect(data<View>(await app.inject({ method: 'GET', url: `/api/questions/${q2.id}?waitMs=200`, headers: as(a.token) })).status).toBe('pending');
    expect((await app.inject({ method: 'GET', url: `/api/questions/${q2.id}?waitMs=60000`, headers: as(a.token) })).statusCode).toBe(400);
    off();
    expect(seen.filter((e) => e.questionId === q.id).map((e) => e.type)).toEqual(['question.asked', 'question.answered']);
    expect(JSON.stringify(seen)).not.toContain('pelican');
  });
});

describe('expiry', () => {
  it('the questions.expire job marks overdue questions expired and withdraws their handoffs', async () => {
    const a = await login(`q-exp-${stamp}@example.test`);
    const free = data<View>(await app.inject({ method: 'POST', url: '/api/questions', headers: as(a.token), payload: { input: 'text', prompt: 'Soon gone', timeoutMs: 10_000 } }));
    const hid = randomUUID();
    const bound = await questions.mirrorHandoff({ id: a.userId }, questions.parseSpec({ input: 'none', kind: 'captcha', prompt: 'Solve it' }), { id: hid, viewerUrl: null, pageTitle: null, expiresAt: new Date(Date.now() + 60_000) }, { askedBy: 'agent:x', runId: null, fabricSessionId: randomUUID() });
    const fresh = data<View>(await app.inject({ method: 'POST', url: '/api/questions', headers: as(a.token), payload: { input: 'none', prompt: 'Not yet' } }));
    await prisma.question.updateMany({ where: { id: { in: [free.id, bound.id] } }, data: { expiresAt: new Date(Date.now() - 1_000) } });

    await app.get(QuestionsExpireHandler, { strict: false }).process({ id: 'job-test' } as Job);

    const rows = await prisma.question.findMany({ where: { id: { in: [free.id, bound.id, fresh.id] } } });
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({ [free.id]: 'expired', [bound.id]: 'expired', [fresh.id]: 'pending' });
    expect(calls).toContainEqual(['POST', `/v1/handoffs/${hid}/cancel`, undefined]);
    const late = await app.inject({ method: 'POST', url: `/api/questions/${free.id}/answer`, headers: as(a.token), payload: { value: 'too late' } });
    expect(late.statusCode).toBe(409);
    expect(late.json<{ message: string }>().message).toMatch(/expired/);
  });
});

describe('browser-bound questions', () => {
  it('forwards a secret to the fabric and never stores or returns it', async () => {
    const a = await login(`q-secret-${stamp}@example.test`);
    const db = prisma.forUser({ userId: a.userId });
    const hid = randomUUID();
    handoffs.set(hid, { id: hid, status: 'pending', input: 'secret', kind: 'code', prompt: 'Code', choices: [] });
    const run = await db.run.create({ data: { userId: a.userId, goal: 'Sign in', trigger: 'external', status: 'waiting_human', handoffId: hid, sessionId: randomUUID() } });
    const q = await questions.mirrorHandoff({ id: a.userId }, questions.parseSpec({ input: 'secret', kind: 'code', prompt: 'Code' }), { id: hid, viewerUrl: null, pageTitle: null, expiresAt: null }, { askedBy: 'agent:x', runId: run.id, fabricSessionId: run.sessionId });

    const res = await app.inject({ method: 'POST', url: `/api/questions/${q.id}/answer`, headers: as(a.token), payload: { value: SECRET, channel: 'cli' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect(data<View>(res).response).toMatchObject({ outcome: 'completed', valueWithheld: true, channel: 'cli' });
    expect(calls).toContainEqual(['POST', `/v1/handoffs/${hid}/respond`, { outcome: 'completed', value: SECRET, channel: 'cli', answered_by: `user:${a.userId}` }]);
    const row = await prisma.question.findUniqueOrThrow({ where: { id: q.id } });
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect((await app.inject({ method: 'GET', url: `/api/questions/${q.id}`, headers: as(a.token) })).body).not.toContain(SECRET);
    // An external run is resumed by its own agent, not by the broker.
    expect(enqueued.filter((j) => j.subjectId === run.id)).toEqual([]);
  });

  it('forwards a sign-in to the fabric: the username is kept, the password is not, and the remember choice is recorded (#527)', async () => {
    const a = await login(`q-signin-${stamp}@example.test`);
    const db = prisma.forUser({ userId: a.userId });
    const hid = randomUUID();
    handoffs.set(hid, { id: hid, status: 'pending', input: 'credentials', kind: 'login', prompt: 'Sign in', choices: [] });
    const run = await db.run.create({ data: { userId: a.userId, goal: 'Read the balance', trigger: 'external', status: 'waiting_human', handoffId: hid, sessionId: randomUUID() } });
    const q = await questions.mirrorHandoff(
      { id: a.userId },
      questions.parseSpec({ input: 'credentials', kind: 'login', prompt: 'Sign in to Example Bank', rememberLabel: 'Keep me signed in' }),
      { id: hid, viewerUrl: null, pageTitle: null, expiresAt: null },
      { askedBy: 'agent:x', runId: run.id, fabricSessionId: run.sessionId },
    );
    expect(q).toMatchObject({ input: 'credentials', rememberLabel: 'Keep me signed in' });

    // Not from a channel that does not sign the person in; not without a password.
    const viaWebhook = await app.inject({ method: 'POST', url: `/api/questions/${q.id}/answer`, headers: as(a.token), payload: { value: 'oscar', secret: SECRET, channel: 'webhook' } });
    expect(viaWebhook.statusCode).toBe(403);
    expect(viaWebhook.json<{ message: string }>().message).toMatch(/^A sign-in cannot be answered from a webhook receiver/);
    const noPassword = await app.inject({ method: 'POST', url: `/api/questions/${q.id}/answer`, headers: as(a.token), payload: { value: 'oscar', channel: 'web' } });
    expect(noPassword.statusCode).toBe(400);

    const res = await app.inject({ method: 'POST', url: `/api/questions/${q.id}/answer`, headers: as(a.token), payload: { value: 'oscar', secret: SECRET, remember: true, channel: 'web' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect(data<View>(res).response).toMatchObject({ outcome: 'completed', value: 'oscar', valueWithheld: true, remember: true, channel: 'web' });
    expect(calls).toContainEqual(['POST', `/v1/handoffs/${hid}/respond`, { outcome: 'completed', value: 'oscar', secret: SECRET, remember: true, channel: 'web', answered_by: `user:${a.userId}` }]);
    const row = await prisma.question.findUniqueOrThrow({ where: { id: q.id } });
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect((await app.inject({ method: 'GET', url: `/api/questions/${q.id}`, headers: as(a.token) })).body).not.toContain(SECRET);
  });

  it('a run handoff answered through the questions API resumes the run', async () => {
    const a = await login(`q-run-${stamp}@example.test`);
    const db = prisma.forUser({ userId: a.userId });
    const run = await db.run.create({ data: { userId: a.userId, goal: 'Pick a seat' } });
    // The goal runner asks through request_human: the broker mirrors the handoff.
    const runTools = jest.fn(async (req: { tools: { tool: { name: string }; execute: (x: unknown, c: unknown) => Promise<unknown> }[]; onStep?: (s: unknown) => void }) => {
      const ask = req.tools.find((t) => t.tool.name === 'request_human')!;
      await ask.execute({ kind: 'other', prompt: 'Aisle or window?', input: 'choice', choices: ['Aisle', 'Window'] }, {});
      req.onStep?.({ response: { usage: { inputTokens: 1, outputTokens: 1 } } });
      return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
    });
    const runner = new GoalRunnerService(prisma, app.get(TasksService), fabric as unknown as FabricClient, { forUser: () => ({ runTools }) } as unknown as AiService, undefined, questions);
    expect(await runner.advance(run.id, a.userId, null)).toBe('waiting_human');
    const waiting = await db.run.findFirstOrThrow({ where: { id: run.id } });
    const q = await db.question.findFirstOrThrow({ where: { runId: run.id } });
    expect(q).toMatchObject({ handoffId: waiting.handoffId, askedBy: `run:${run.id}`, input: 'choice', status: 'pending', viewerUrl: `https://viewer.example.test/${waiting.handoffId}`, pageTitle: 'Shop' });
    const inbox = data<{ runId: string; goal: string }[]>(await app.inject({ method: 'GET', url: '/api/inbox', headers: as(a.token) }));
    expect(inbox).toEqual([expect.objectContaining({ runId: run.id, goal: 'Pick a seat' })]);

    const res = await app.inject({ method: 'POST', url: `/api/questions/${q.id}/answer`, headers: as(a.token), payload: { value: 'Window' } });
    expect(res.statusCode).toBe(200);
    expect(enqueued).toContainEqual(expect.objectContaining({ type: 'browser.goal.run', subjectId: run.id }));

    // The resumed run reads the answer.
    runTools.mockImplementationOnce(async (req) => {
      const finish = req.tools.find((t) => t.tool.name === 'finish')!;
      await finish.execute({ success: true, result: 'Seat chosen' }, {});
      req.onStep?.({ response: { usage: { inputTokens: 1, outputTokens: 1 } } });
      return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
    });
    expect(await runner.advance(run.id, a.userId, null)).toBe('succeeded');
    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(JSON.stringify(done.transcript)).toContain('The person chose: Window');
  });

  it('settles a mirrored question the fabric expired', async () => {
    const a = await login(`q-rec-${stamp}@example.test`);
    const hid = randomUUID();
    const q = await questions.mirrorHandoff({ id: a.userId }, questions.parseSpec({ input: 'text', prompt: 'Name?' }), { id: hid, viewerUrl: null, pageTitle: null, expiresAt: null }, { askedBy: 'agent:x', runId: null, fabricSessionId: randomUUID() });
    await questions.reconcileHandoff({ id: hid, status: 'expired', input: 'text', kind: 'other' });
    expect((await prisma.question.findUniqueOrThrow({ where: { id: q.id } })).status).toBe('expired');
    const hid2 = randomUUID();
    const q2 = await questions.mirrorHandoff({ id: a.userId }, questions.parseSpec({ input: 'text', prompt: 'Name?' }), { id: hid2, viewerUrl: null, pageTitle: null, expiresAt: null }, { askedBy: 'agent:x', runId: null, fabricSessionId: randomUUID() });
    await questions.reconcileHandoff({ id: hid2, status: 'completed', input: 'text', kind: 'other', response: { outcome: 'completed', value: 'Person A', value_withheld: false, channel: 'slack', by: 'user:x', answered_at: new Date().toISOString() } });
    expect(await prisma.question.findUniqueOrThrow({ where: { id: q2.id } })).toMatchObject({ status: 'answered', answeredChannel: 'slack', response: expect.objectContaining({ value: 'Person A', channel: 'slack' }) });
  });
});
