// Reminders while a run waits for its person (#298), against a real database:
// waiting schedules them and answering clears them; a due reminder goes out
// once and schedules the next; an answered request is never reminded about;
// "Remind me in 15 min" from the notification moves the next one, once.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { FabricError } from '../src/fabric/fabric.client';
import type { FabricHandoff } from '../src/runner/fabric-session';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { RunActionTokens } from '../src/tasks/run-action-token';
import { RunNotifier } from '../src/tasks/run-notifier';
import { RunReminders } from '../src/tasks/run-reminders';
import { TasksService } from '../src/tasks/tasks.service';

const MIN = 60_000;
let app: NestFastifyApplication;
let prisma: PrismaService;
let tokens: RunActionTokens;
let reminders: RunReminders;
let tasks: TasksService;
let reminded: jest.SpyInstance;
/** The handoff the in-memory fabric reports, per handoff id (the fabric's `HandoffView` fields the reminder reads). */
const handoffs = new Map<string, (Omit<Partial<FabricHandoff>, 'status'> & { status: string }) | Error>();
const fabric = {
  request: jest.fn(async (_method: string, path: string) => {
    const h = handoffs.get(path.split('/').pop()!);
    if (h instanceof Error) throw h;
    if (!h) throw new FabricError('not_found' as never, 'not found', 404);
    return h;
  }),
};

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  tokens = app.get(RunActionTokens, { strict: false });
  reminders = app.get(RunReminders, { strict: false });
  tasks = app.get(TasksService, { strict: false });
  Object.assign(reminders, { fabric });
  reminded = jest.spyOn(app.get(RunNotifier, { strict: false }), 'reminder');
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => reminded.mockClear());

async function user(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return me.json<{ data: { id: string } }>().data.id;
}

const hid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let seq = 0;

/** A run that started waiting `agoMin` minutes ago on a request lasting `windowMin`. */
async function waiting(agoMin: number, windowMin: number, status = 'pending') {
  const uid = await user(`rem-${Date.now()}-${seq++}@example.test`);
  const handoffId = hid(1000 + seq);
  const since = new Date(Date.now() - agoMin * MIN);
  const expiresAt = new Date(since.getTime() + windowMin * MIN);
  handoffs.set(handoffId, { status, expires_at: expiresAt.toISOString(), kind: 'code', prompt: 'Enter the code sent to your phone', input: 'secret' });
  const run = await prisma.run.create({
    data: {
      userId: uid, goal: 'Find a fare', trigger: 'external', status: 'waiting_human', handoffId, startedAt: since,
      waitingSince: since, handoffExpiresAt: expiresAt, remindAt: new Date(since.getTime() + 3 * MIN),
    },
  });
  return { uid, run, handoffId, since, expiresAt };
}

const runOf = (id: string) => prisma.run.findUniqueOrThrow({ where: { id } });

describe('reminders while a run waits (browser.runs.remind)', () => {
  it('waiting schedules the first reminder; leaving waiting clears it', async () => {
    const uid = await user(`rem-tr-${Date.now()}@example.test`);
    const run = await prisma.run.create({ data: { userId: uid, goal: 'Book a table', trigger: 'external', status: 'running', startedAt: new Date() } });
    const before = Date.now();
    await tasks.transition(uid, run.id, 'waiting_human', { handoffId: hid(1), handoffExpiresAt: new Date(before + 30 * MIN) });
    const w = await runOf(run.id);
    expect(w.waitingSince!.getTime()).toBeGreaterThanOrEqual(before);
    // 25 % of a 30 min window.
    expect(Math.abs(w.remindAt!.getTime() - w.waitingSince!.getTime() - 7.5 * MIN)).toBeLessThan(1000);
    expect(w).toMatchObject({ reminderCount: 0, remindedAt: null, snoozedUntil: null });
    await tasks.transition(uid, run.id, 'running', { handoffId: null });
    expect(await runOf(run.id)).toMatchObject({ remindAt: null, snoozedUntil: null });
  });

  it('a due reminder goes out once, with fresh buttons, and the next one is scheduled', async () => {
    const { uid, run, expiresAt } = await waiting(8, 30);
    expect(await reminders.sendDue()).toBeGreaterThanOrEqual(1);
    expect(reminded).toHaveBeenCalledTimes(1);
    const [to, ref, ask, when] = reminded.mock.calls[0];
    expect(to).toBe(uid);
    expect(ref).toMatchObject({ id: run.id });
    expect(ask).toEqual({ prompt: 'Enter the code sent to your phone', kind: 'code', input: 'secret' });
    expect(when.reminderCount).toBe(1);
    const after = await runOf(run.id);
    expect(after.reminderCount).toBe(1);
    expect(after.remindAt!.getTime()).toBe(expiresAt.getTime() - 5 * MIN);
    // Nothing more is due now.
    reminded.mockClear();
    await reminders.sendDue();
    expect(reminded.mock.calls.filter((c) => c[1].id === run.id)).toHaveLength(0);
  });

  it('never reminds about an answered request or a run that stopped waiting', async () => {
    const answered = await waiting(8, 30, 'completed');
    const stopped = await waiting(8, 30);
    await prisma.run.update({ where: { id: stopped.run.id }, data: { status: 'cancelled' } });
    await reminders.sendDue();
    expect(reminded.mock.calls.filter((c) => [answered.run.id, stopped.run.id].includes(c[1].id))).toHaveLength(0);
    expect((await runOf(answered.run.id)).remindAt).toBeNull();
  });

  it('reads the typed fabric shape: a response with an outcome settles the request', async () => {
    const secret = await waiting(8, 30);
    handoffs.set(secret.handoffId, { status: 'completed', input: 'secret', kind: 'code', response: { outcome: 'completed', value_withheld: true, channel: 'notification', by: 'user:x' } });
    const declined = await waiting(8, 30);
    handoffs.set(declined.handoffId, { status: 'cancelled', input: 'confirm', kind: 'confirm', response: { outcome: 'cancelled', channel: 'inbox' } });
    await reminders.sendDue();
    expect(reminded.mock.calls.filter((c) => [secret.run.id, declined.run.id].includes(c[1].id))).toHaveLength(0);
    expect((await runOf(secret.run.id)).remindAt).toBeNull();
    expect((await runOf(declined.run.id)).remindAt).toBeNull();
  });

  it('a fabric it cannot reach is tried again in a minute, without a reminder', async () => {
    const { run, handoffId } = await waiting(8, 30);
    handoffs.set(handoffId, new FabricError('unavailable' as never, 'fabric unreachable', 503));
    const t = Date.now();
    await reminders.sendDue();
    expect(reminded.mock.calls.filter((c) => c[1].id === run.id)).toHaveLength(0);
    const r = await runOf(run.id);
    expect(r.remindAt!.getTime()).toBeGreaterThanOrEqual(t + MIN - 1000);
    expect(r.reminderCount).toBe(0);
  });
});

describe('Remind me in 15 min (POST /api/notification-actions, snooze)', () => {
  const act = (token: string, action: string) => app.inject({ method: 'POST', url: '/api/notification-actions', payload: { token, action } });

  it('moves the next reminder 15 min out, once', async () => {
    const { uid, run } = await waiting(1, 120);
    const token = tokens.issue(uid, run.id, null);
    const t = Date.now();
    expect((await act(token, 'snooze')).statusCode).toBe(200);
    const r = await runOf(run.id);
    expect(r.snoozedUntil!.getTime()).toBeGreaterThanOrEqual(t + 15 * MIN - 1000);
    expect(r.remindAt).toEqual(r.snoozedUntil);
    expect((await act(token, 'snooze')).statusCode).toBe(401);
  });

  it('is refused with too little time left, or once the run stopped waiting', async () => {
    const late = await waiting(1, 15);
    expect((await act(tokens.issue(late.uid, late.run.id, null), 'snooze')).statusCode).toBe(409);
    const done = await waiting(1, 120);
    await prisma.run.update({ where: { id: done.run.id }, data: { status: 'succeeded' } });
    expect((await act(tokens.issue(done.uid, done.run.id, null), 'snooze')).statusCode).toBe(409);
  });

  it('a snoozed run is reminded when the snooze runs out, and not before', async () => {
    const { uid, run } = await waiting(20, 240);
    await reminders.snooze(uid, run.id, new Date(Date.now() - 16 * MIN));
    await reminders.sendDue();
    expect(reminded.mock.calls.filter((c) => c[1].id === run.id)).toHaveLength(1);
    expect((await runOf(run.id)).snoozedUntil).toBeNull();
  });
});
