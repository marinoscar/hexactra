// The Home summary (#430) against a real, migrated and seeded database: each
// block's content, limits and order, the permission gates, what never leaves
// the API, the fleet's time limit, and the number of statements.
import { ServiceUnavailableException } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { addDaysToDateKey, zonedDateKey } from '@marinoscar/platform-contract/timezone';
import { Client } from 'pg';

import type { FleetHost } from '../src/fleet/fleet.schemas';
import { FleetService } from '../src/fleet/fleet.service';
import { FLEET_TIMEOUT_MS, HomeService, type HomeSummary } from '../src/home/home.service';
import { createApp } from '../src/main';
import { builtinPolicy } from '../src/policies/builtin-policies';
import { PrismaService } from '../src/prisma/prisma.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
let home: HomeService;
let fleet: jest.SpyInstance<Promise<FleetHost[]>, []>;
const stamp = `${Date.now()}`;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const ALL = ['runs:read', 'runs:write', 'tasks:read', 'tasks:write', 'fleet:read'];

/** The summary as it is on the wire (dates are ISO strings). */
type Wire = {
  generatedAt: string;
  timezone: string;
  needsYou: { count: number; items: Record<string, unknown>[] } | null;
  liveRuns: { count: number; items: Record<string, unknown>[] } | null;
  upcoming: { items: Record<string, unknown>[]; pausedCount: number; failingCount: number } | null;
  recentRuns: { items: Record<string, unknown>[] } | null;
  week: { totals: Record<string, unknown>; series: { date: string; succeeded: number; failed: number; cancelled: number; costUsd: number | null }[] } | null;
  fleet: { total: number; online: number; disabled: number; stale: boolean; hosts: Record<string, unknown>[] } | null;
  counts: { tasks: number | null; runs: number | null };
};

async function login(email: string, role: 'contributor' | 'viewer' = 'contributor') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
const summaryOf = async (token: string, headers: Record<string, string> = {}): Promise<Wire> => {
  const res = await app.inject({ method: 'GET', url: '/api/home/summary', headers: { authorization: `Bearer ${token}`, ...headers } });
  expect(res.statusCode).toBe(200);
  return res.json<{ data: Wire }>().data;
};

const host = (id: string, name: string, extra: Partial<FleetHost> = {}): FleetHost => ({
  id,
  name,
  version: '1.0.0',
  online: true,
  browserConnected: true,
  onDemand: true,
  draining: false,
  viewerUrl: 'https://viewer.example.test/secret-path',
  mode: 'unattended',
  desktop: true,
  profiles: [{ name: 'default', running: false }],
  lastSeen: new Date().toISOString(),
  ...extra,
});
const HOST_A = '00000000-0000-4000-8000-0000000000a1';

const snapshot = (name: string, limits: Record<string, number | null>, warnAtPercent = 80) => ({
  schemaVersion: 1,
  ref: 'builtin:balanced',
  name,
  version: 1,
  builtin: true,
  source: 'task',
  spec: builtinPolicy('builtin:balanced')!.spec,
  tiers: null,
  takenAt: new Date().toISOString(),
  effectiveBudget: {
    limits: { actions: null, modelCalls: null, activeMinutes: null, inputTokens: null, outputTokens: null, cost: null, ...limits },
    source: { actions: null, modelCalls: null, activeMinutes: null, inputTokens: null, outputTokens: null, cost: null },
    warnAtPercent,
  },
});

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  home = app.get(HomeService);
  fleet = jest.spyOn(app.get(FleetService), 'hosts');
  twoHosts();
});
const twoHosts = () => {
  fleet.mockReset();
  fleet.mockResolvedValue([host(HOST_A, 'den-mini'), host('00000000-0000-4000-8000-0000000000a2', 'attic-box', { online: false, mode: 'attended' })]);
};
beforeEach(twoHosts);
afterAll(async () => {
  await app?.close();
});

describe('GET /api/home/summary: a busy account', () => {
  let alice: { token: string; userId: string };
  let bob: { token: string; userId: string };
  const now = Date.now();
  const at = (ms: number) => new Date(now + ms);
  const id = { report: '', fares: '', paused: '', failing: '', limited: '', unlimited: '', soonest: '' };
  let s: Wire;

  beforeAll(async () => {
    alice = await login(`home-alice-${stamp}@example.test`);
    bob = await login(`home-bob-${stamp}@example.test`);
    const userId = alice.userId;
    const task = (name: string, created: number) => prisma.task.create({ data: { userId, name, goal: `Goal of ${name}`, createdAt: at(created) } }).then((t) => t.id);
    id.report = await task('Morning report', -6 * HOUR);
    id.fares = await task('Fare watch', -5 * HOUR);
    id.paused = await task('Paused chores', -4 * HOUR);
    id.failing = await task('Flaky checkout', -3 * HOUR);

    // Six enabled schedules with a next firing (five are listed), one paused, one enabled without a next firing.
    const schedule = (taskId: string, cron: string, enabled: boolean, nextIn: number | null, extra: { consecutiveFailures?: number; timezone?: string } = {}) =>
      prisma.taskSchedule.create({ data: { userId, taskId, cron, timezone: 'Europe/Madrid', enabled, nextRunAt: nextIn === null ? null : at(nextIn), ...extra } });
    await schedule(id.report, '0 9 * * 1-5', true, 3 * HOUR);
    await schedule(id.report, '0 17 * * *', true, 6 * HOUR);
    await schedule(id.fares, '30 9 * * *', true, 1 * HOUR, { timezone: 'UTC' });
    await schedule(id.fares, '0 12 * * *', true, 2 * HOUR);
    await schedule(id.fares, '0 13 * * *', true, 4 * HOUR);
    await schedule(id.fares, '0 14 * * *', true, 5 * HOUR);
    await schedule(id.fares, '0 15 * * *', true, null);
    await schedule(id.paused, '5 4 * * *', false, null);
    await schedule(id.failing, '0 */2 * * *', true, 7 * HOUR, { consecutiveFailures: 3 });

    const run = (data: Record<string, unknown>) => prisma.run.create({ data: { userId, goal: 'g', ...data } as never });
    // Live: four running, two waiting, two queued (eight; six are listed).
    id.limited = (
      await run({
        taskId: id.report,
        status: 'running',
        goal: 'Read the report',
        createdAt: at(-10 * MIN),
        startedAt: at(-9 * MIN),
        hostId: HOST_A,
        stepCount: 30,
        modelCalls: 12,
        costUsd: 1.24,
        activeMs: 5 * MIN,
        currentTier: 'frontier',
        transcript: [{ role: 'user', content: 'TRANSCRIPT-MARKER' }],
        policySnapshot: snapshot('Balanced', { actions: 60, cost: 2, activeMinutes: 20 }, 70),
        activity: { phase: 'acting', action: 'click_at', args: { x: 612, y: 340, text: 'ARGS-MARKER' }, target: { x: 612, y: 340 }, reason: 'Open the report', startedAt: at(-5_000).toISOString(), timeoutMs: 45_000 },
      })
    ).id;
    id.unlimited = (await run({ status: 'running', goal: 'Free roaming', createdAt: at(-20 * MIN), startedAt: at(-19 * MIN), stepCount: 400, policySnapshot: snapshot('Unlimited', {}) })).id;
    await run({ status: 'running', createdAt: at(-30 * MIN) });
    await run({ status: 'running', createdAt: at(-40 * MIN) });
    const waiting = await run({ taskId: id.fares, status: 'waiting_human', goal: 'Book the fare', createdAt: at(-5 * MIN), activity: { phase: 'thinking', startedAt: at(-1000).toISOString() } });
    const waiting2 = await run({ status: 'waiting_human', createdAt: at(-50 * MIN) });
    await run({ status: 'queued', createdAt: at(-1 * MIN) });
    await run({ status: 'queued', createdAt: at(-2 * MIN) });

    // Finished: ten in the week (eight are listed), one before it.
    const done = (status: string, finishedAgo: number, extra: Record<string, unknown> = {}) =>
      run({ status, createdAt: at(-finishedAgo - 5 * MIN), startedAt: at(-finishedAgo - 4 * MIN), finishedAt: at(-finishedAgo), ...extra });
    await done('succeeded', 1 * HOUR, { taskId: id.report, goal: 'Newest finished', trigger: 'schedule', stepCount: 14, stopReason: 'finished', modelCalls: 9, costUsd: 0.5 });
    await done('failed', 2 * HOUR, { taskId: id.failing, stopReason: 'error', error: 'The page did not load\nstack line two', modelCalls: 3, costUsd: 0.25, costKnown: false });
    await done('failed', 3 * HOUR, { stopReason: 'budget_cost', modelCalls: 40, costUsd: 2 });
    await done('failed', 4 * HOUR, { stopReason: 'budget_actions', modelCalls: 5, costUsd: 0.1 });
    await done('failed', 5 * HOUR, { stopReason: 'stalled', modelCalls: 5, costUsd: 0.15 });
    await done('cancelled', 6 * HOUR, { stopReason: 'cancelled' });
    await done('succeeded', 1 * DAY + HOUR, { modelCalls: 2, costUsd: 1 });
    await done('succeeded', 2 * DAY + HOUR, { modelCalls: 2, costUsd: 1 });
    await done('succeeded', 3 * DAY + HOUR, { goal: 'Ninth finished' });
    await done('succeeded', 4 * DAY + HOUR, { goal: 'Tenth finished' });
    await done('failed', 20 * DAY, { goal: 'Long ago', costUsd: 50, modelCalls: 1 });

    // Questions: five pending (three are listed), one answered, one already past its expiry.
    const question = (data: Record<string, unknown>) => prisma.question.create({ data: { ownerUserId: userId, askedBy: 'run:test', prompt: 'p', ...data } as never });
    await question({ runId: waiting.id, input: 'confirm', kind: 'confirmation', prompt: 'Buy the ticket for 120 EUR?', risk: 'low', expiresAt: at(20 * MIN), viewerUrl: 'https://viewer.example.test/VIEWER-MARKER' });
    id.soonest = (await question({ runId: waiting2.id, input: 'secret', kind: 'code', prompt: `Enter the code. ${'x'.repeat(400)}`, expiresAt: at(4 * MIN) })).id;
    await question({ input: 'confirm', kind: 'confirmation', prompt: 'Delete the account?', risk: 'high', expiresAt: at(10 * MIN) });
    await question({ input: 'text', prompt: 'Later one', expiresAt: at(30 * MIN) });
    await question({ input: 'text', prompt: 'Last one', expiresAt: at(40 * MIN) });
    await question({ input: 'text', prompt: 'Answered', status: 'answered', expiresAt: at(50 * MIN), response: { outcome: 'completed', value: 'ANSWER-MARKER', valueWithheld: false } });
    await question({ input: 'text', prompt: 'Expired but not yet swept', expiresAt: at(-1 * MIN) });

    // Bob's own rows: none of them may show up for Alice.
    const other = await prisma.task.create({ data: { userId: bob.userId, name: 'BOB-TASK', goal: 'BOB-GOAL' } });
    await prisma.taskSchedule.create({ data: { userId: bob.userId, taskId: other.id, cron: '0 9 * * *', timezone: 'UTC', nextRunAt: at(1 * MIN) } });
    const bobRun = await prisma.run.create({ data: { userId: bob.userId, taskId: other.id, goal: 'BOB-GOAL', status: 'running' } });
    await prisma.run.create({ data: { userId: bob.userId, goal: 'BOB-GOAL', status: 'failed', finishedAt: at(-1000), error: 'BOB-ERROR' } });
    await prisma.question.create({ data: { ownerUserId: bob.userId, askedBy: 'run:test', runId: bobRun.id, prompt: 'BOB-QUESTION', expiresAt: at(1 * MIN) } });

    s = await summaryOf(alice.token, { 'x-time-zone': 'Europe/Madrid' });
  });

  it('needs you: the count of every pending question, the three that expire first, the prompt cut to 300 characters', () => {
    expect(s.needsYou!.count).toBe(5);
    expect(s.needsYou!.items.map((q) => q.prompt)).toEqual([expect.stringMatching(/^Enter the code\./), 'Delete the account?', 'Buy the ticket for 120 EUR?']);
    expect(s.needsYou!.items[0]!.questionId).toBe(id.soonest);
    expect((s.needsYou!.items[0]!.prompt as string).length).toBe(300);
    expect(s.needsYou!.items[2]).toMatchObject({ kind: 'confirmation', input: 'confirm', risk: 'low', goal: 'Book the fare' });
    expect(s.needsYou!.items[1]).toMatchObject({ risk: 'high', runId: null, goal: null });
  });

  it('carries no secret-bearing field: exact key sets, and no transcript, snapshot, arguments, answer or viewer URL anywhere', () => {
    expect(Object.keys(s.needsYou!.items[0]!).sort()).toEqual(['createdAt', 'expiresAt', 'goal', 'input', 'kind', 'prompt', 'questionId', 'risk', 'runId']);
    expect(Object.keys(s.liveRuns!.items[0]!).sort()).toEqual(
      ['activity', 'budgetPercent', 'budgetWarnPercent', 'currentTier', 'goal', 'hostId', 'hostName', 'id', 'policyName', 'startTier', 'startedAt', 'status', 'stepCount', 'taskId', 'taskName'].sort(),
    );
    expect(Object.keys(s.recentRuns!.items[0]!).sort()).toEqual(
      ['costKnown', 'costUsd', 'createdAt', 'error', 'finishedAt', 'goal', 'id', 'startedAt', 'status', 'stepCount', 'stopReason', 'taskId', 'taskName', 'trigger'].sort(),
    );
    expect(Object.keys(s.fleet!.hosts[0]!).sort()).toEqual(['draining', 'id', 'mode', 'name', 'online']);
    const limited = s.liveRuns!.items.find((r) => r.id === id.limited)!;
    expect(Object.keys(limited.activity as object).sort()).toEqual(['action', 'note', 'phase', 'reason', 'startedAt']);
    const text = JSON.stringify(s);
    for (const marker of ['TRANSCRIPT-MARKER', 'ARGS-MARKER', 'ANSWER-MARKER', 'VIEWER-MARKER', 'secret-path', 'policySnapshot', 'transcript', 'effectiveBudget', '"args"', 'viewerUrl', '"response"']) expect(text).not.toContain(marker);
  });

  it('live runs: the count of all, six listed, running first then waiting then queued, newest first within each', () => {
    expect(s.liveRuns!.count).toBe(8);
    expect(s.liveRuns!.items.map((r) => r.status)).toEqual(['running', 'running', 'running', 'running', 'waiting_human', 'waiting_human']);
    expect(s.liveRuns!.items[0]).toMatchObject({
      id: id.limited,
      taskId: id.report,
      taskName: 'Morning report',
      goal: 'Read the report',
      stepCount: 30,
      hostId: HOST_A,
      hostName: 'den-mini',
      policyName: 'Balanced',
      currentTier: 'frontier',
      startTier: builtinPolicy('builtin:balanced')!.spec.models.startTier,
      activity: { phase: 'acting', action: 'click_at', reason: 'Open the report', note: null },
    });
    expect(s.liveRuns!.items[1]).toMatchObject({ id: id.unlimited, taskName: null, hostName: null });
    // A waiting run shows no activity: nothing is being done while a person is asked.
    expect(s.liveRuns!.items[4]).toMatchObject({ status: 'waiting_human', goal: 'Book the fare', activity: null });
  });

  it('budgetPercent is the highest percent among the limited budgets, and null for an unlimited run', () => {
    const limited = s.liveRuns!.items.find((r) => r.id === id.limited)!;
    // actions 30/60 = 50 %, cost 1.24/2 = 62 %, active time 5/20 min = 25 %.
    expect(limited.budgetPercent).toBe(62);
    expect(limited.budgetWarnPercent).toBe(70);
    const unlimited = s.liveRuns!.items.find((r) => r.id === id.unlimited)!;
    expect(unlimited.budgetPercent).toBeNull();
    expect(unlimited.budgetWarnPercent).toBeNull();
    // A run that has not started has no snapshot, so no budget either.
    expect(s.liveRuns!.items[2]).toMatchObject({ budgetPercent: null, policyName: null, currentTier: null });
  });

  it('upcoming: five enabled schedules by next firing, with the sentence, and the paused and failing task counts', () => {
    expect(s.upcoming!.items).toHaveLength(5);
    expect(s.upcoming!.items.map((u) => u.taskName)).toEqual(['Fare watch', 'Fare watch', 'Morning report', 'Fare watch', 'Fare watch']);
    const times = s.upcoming!.items.map((u) => Date.parse(u.nextRunAt as string));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(s.upcoming!.items[0]).toMatchObject({ taskId: id.fares, description: 'Every day at 09:30', timezone: 'UTC' });
    expect(s.upcoming!.items[2]).toMatchObject({ taskId: id.report, description: 'Monday to Friday at 09:00', timezone: 'Europe/Madrid' });
    expect(Object.keys(s.upcoming!.items[0]!).sort()).toEqual(['description', 'nextRunAt', 'scheduleId', 'taskId', 'taskName', 'timezone']);
    expect(s.upcoming!.pausedCount).toBe(1);
    expect(s.upcoming!.failingCount).toBe(1);
  });

  it('the paused and failing counts equal what the task list filters return', async () => {
    const total = async (filter: string) =>
      (await app.inject({ method: 'GET', url: `/api/tasks?envelope=1&filter=${filter}`, headers: { authorization: `Bearer ${alice.token}` } })).json<{ data: { total: number } }>().data.total;
    expect(await total('paused')).toBe(s.upcoming!.pausedCount);
    expect(await total('failing')).toBe(s.upcoming!.failingCount);
  });

  it('recent runs: the eight most recently finished, with stop reason, cost and the first line of a failure', () => {
    expect(s.recentRuns!.items).toHaveLength(8);
    const finished = s.recentRuns!.items.map((r) => Date.parse(r.finishedAt as string));
    expect([...finished].sort((a, b) => b - a)).toEqual(finished);
    expect(s.recentRuns!.items[0]).toMatchObject({ goal: 'Newest finished', taskName: 'Morning report', status: 'succeeded', trigger: 'schedule', stepCount: 14, stopReason: 'finished', costUsd: 0.5, costKnown: true, error: null });
    expect(s.recentRuns!.items[1]).toMatchObject({ status: 'failed', taskName: 'Flaky checkout', stopReason: 'error', error: 'The page did not load', costUsd: 0.25, costKnown: false });
    // No model call: no cost to show.
    expect(s.recentRuns!.items[5]).toMatchObject({ status: 'cancelled', costUsd: null });
    expect(s.recentRuns!.items.map((r) => r.goal)).not.toContain('Ninth finished');
    expect(s.recentRuns!.items.every((r) => ['succeeded', 'failed', 'cancelled'].includes(r.status as string))).toBe(true);
  });

  it('the week: seven days in the profile zone, zero-filled, with totals that match the seeded runs', () => {
    expect(s.timezone).toBe('Europe/Madrid');
    const today = zonedDateKey(new Date(Date.parse(s.generatedAt)), 'Europe/Madrid');
    expect(s.week!.series.map((d) => d.date)).toEqual(Array.from({ length: 7 }, (_, i) => addDaysToDateKey(today, i - 6)));
    const sum = (k: 'succeeded' | 'failed' | 'cancelled') => s.week!.series.reduce((n, d) => n + d[k], 0);
    expect([sum('succeeded'), sum('failed'), sum('cancelled')]).toEqual([5, 4, 1]);
    // Two days have no run at all (five and six days ago): zeros, never a missing day.
    const empty = s.week!.series.filter((d) => d.succeeded + d.failed + d.cancelled === 0);
    expect(empty.length).toBeGreaterThanOrEqual(1);
    for (const d of empty) expect(d).toMatchObject({ succeeded: 0, failed: 0, cancelled: 0 });
    // Finished: 0.5 + 0.25 + 2 + 0.1 + 0.15 + 1 + 1 = 5; the live run adds 1.24. The run of 20 days ago is outside.
    expect(s.week!.totals).toEqual({ succeeded: 5, failed: 4, cancelled: 1, successRate: 0.5556, costUsd: 6.24, costKnown: false, budgetStops: 2, stalled: 1 });
    expect(s.week!.series.reduce((n, d) => n + (d.costUsd ?? 0), 0)).toBeCloseTo(6.24, 6);
  });

  it('costKnown is true when every run of the week was priced', async () => {
    await prisma.run.updateMany({ where: { userId: alice.userId, costKnown: false }, data: { costKnown: true } });
    const again = await summaryOf(alice.token);
    expect(again.week!.totals).toMatchObject({ costUsd: 6.24, costKnown: true });
    expect(again.timezone).toBe('UTC');
  });

  it('the fleet: totals, at most six hosts, online first; the counts for the first-run checklist', () => {
    expect(s.fleet).toEqual({
      total: 2,
      online: 1,
      disabled: 0,
      stale: false,
      hosts: [
        { id: HOST_A, name: 'den-mini', online: true, draining: false, mode: 'unattended' },
        { id: '00000000-0000-4000-8000-0000000000a2', name: 'attic-box', online: false, draining: false, mode: 'attended' },
      ],
    });
    expect(s.counts).toEqual({ tasks: 4, runs: 19 });
  });

  it('lists six hosts of a larger fleet and counts the draining ones', async () => {
    fleet.mockResolvedValue(Array.from({ length: 8 }, (_, i) => host(`00000000-0000-4000-8000-0000000000b${i}`, `host-${i}`, { online: i % 2 === 0, draining: i < 3 })));
    const big = await summaryOf(alice.token);
    expect(big.fleet).toMatchObject({ total: 8, online: 4, disabled: 3, stale: false });
    expect(big.fleet!.hosts.map((h) => h.name)).toEqual(['host-0', 'host-2', 'host-4', 'host-6', 'host-1', 'host-3']);
  });

  it("contains none of another user's rows", () => {
    expect(JSON.stringify(s)).not.toContain('BOB-');
  });

  it("the other user sees only their own rows", async () => {
    const b = await summaryOf(bob.token);
    expect(b.needsYou).toMatchObject({ count: 1, items: [{ prompt: 'BOB-QUESTION', goal: 'BOB-GOAL' }] });
    expect(b.liveRuns!.count).toBe(1);
    expect(b.recentRuns!.items).toHaveLength(1);
    expect(b.upcoming!.items.map((u) => u.taskName)).toEqual(['BOB-TASK']);
    expect(b.counts).toEqual({ tasks: 1, runs: 2 });
  });

  it('builds the summary in at most 8 statements, whatever the account holds', async () => {
    const count = async (userId: string) => {
      const spy = jest.spyOn(Client.prototype, 'query');
      try {
        const out = await home.summary({ userId, permissions: ALL, timezone: 'Europe/Madrid' });
        expect(out.liveRuns).not.toBeNull();
        return spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
    };
    const busy = await count(alice.userId);
    expect(busy).toBeGreaterThan(0); // the spy does see the driver
    expect(busy).toBeLessThanOrEqual(8);
    expect(await count(bob.userId)).toBe(busy);
  });
});

describe('GET /api/home/summary: permissions', () => {
  let carol: { token: string; userId: string };
  beforeAll(async () => {
    carol = await login(`home-carol-${stamp}@example.test`);
    await prisma.task.create({ data: { userId: carol.userId, name: 'Only task', goal: 'g' } });
    await prisma.run.create({ data: { userId: carol.userId, goal: 'g', status: 'running' } });
  });
  const blocks = (s: HomeSummary) => Object.fromEntries((['needsYou', 'liveRuns', 'upcoming', 'recentRuns', 'week', 'fleet'] as const).map((k) => [k, s[k] === null ? null : 'set']));

  it('requires a sign-in', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/home/summary' })).statusCode).toBe(401);
  });

  it('a block the caller may not see is null, never an empty list', async () => {
    const none = await home.summary({ userId: carol.userId, permissions: [], timezone: 'UTC' });
    expect(blocks(none)).toEqual({ needsYou: null, liveRuns: null, upcoming: null, recentRuns: null, week: null, fleet: null });
    expect(none.counts).toEqual({ tasks: null, runs: null });
    expect(fleet).not.toHaveBeenCalled();

    const noFleet = await home.summary({ userId: carol.userId, permissions: ['runs:read', 'tasks:read'], timezone: 'UTC' });
    expect(blocks(noFleet)).toEqual({ needsYou: 'set', liveRuns: 'set', upcoming: 'set', recentRuns: 'set', week: 'set', fleet: null });
    expect(noFleet.counts).toEqual({ tasks: 1, runs: 1 });
    expect(fleet).not.toHaveBeenCalled();

    const runsOnly = await home.summary({ userId: carol.userId, permissions: ['runs:read'], timezone: 'UTC' });
    expect(blocks(runsOnly)).toEqual({ needsYou: 'set', liveRuns: 'set', upcoming: null, recentRuns: 'set', week: 'set', fleet: null });
    expect(runsOnly.counts).toEqual({ tasks: null, runs: 1 });

    const tasksOnly = await home.summary({ userId: carol.userId, permissions: ['tasks:read'], timezone: 'UTC' });
    expect(blocks(tasksOnly)).toEqual({ needsYou: null, liveRuns: null, upcoming: 'set', recentRuns: null, week: null, fleet: null });
    expect(tasksOnly.counts).toEqual({ tasks: 1, runs: null });

    const fleetOnly = await home.summary({ userId: carol.userId, permissions: ['fleet:read'], timezone: 'UTC' });
    expect(blocks(fleetOnly)).toEqual({ needsYou: null, liveRuns: null, upcoming: null, recentRuns: null, week: null, fleet: 'set' });
  });

  it('a viewer gets the read blocks', async () => {
    const viewer = await login(`home-viewer-${stamp}@example.test`, 'viewer');
    const s = await summaryOf(viewer.token);
    expect(s.needsYou).toEqual({ count: 0, items: [] });
    expect(s.liveRuns).toEqual({ count: 0, items: [] });
    expect(s.upcoming).toEqual({ items: [], pausedCount: 0, failingCount: 0 });
    expect(s.recentRuns).toEqual({ items: [] });
    expect(s.week!.series).toHaveLength(7);
    expect(s.week!.totals).toEqual({ succeeded: 0, failed: 0, cancelled: 0, successRate: null, costUsd: null, costKnown: true, budgetStops: 0, stalled: 0 });
    expect(s.fleet).not.toBeNull();
    expect(s.counts).toEqual({ tasks: 0, runs: 0 });
  });
});

describe('GET /api/home/summary: the fleet never fails the summary', () => {
  let dana: { token: string; userId: string };
  beforeAll(async () => {
    dana = await login(`home-dana-${stamp}@example.test`);
  });

  it('answers with the last known hosts, marked stale, when the fabric does not answer in time', async () => {
    await summaryOf(dana.token); // remembers the two hosts
    fleet.mockImplementation(() => new Promise<FleetHost[]>(() => undefined)); // never answers
    const started = Date.now();
    const s = await summaryOf(dana.token);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(FLEET_TIMEOUT_MS - 50);
    expect(took).toBeLessThan(FLEET_TIMEOUT_MS + 1_500);
    expect(s.fleet).toMatchObject({ total: 2, online: 1, stale: true });
    expect(s.fleet!.hosts.map((h) => h.name)).toEqual(['den-mini', 'attic-box']);
    expect(s.needsYou).toEqual({ count: 0, items: [] });
  });

  it('answers stale when the fabric is unreachable, and with no machines when it is not configured', async () => {
    fleet.mockRejectedValue(new Error('connect ECONNREFUSED'));
    expect((await summaryOf(dana.token)).fleet).toMatchObject({ total: 2, stale: true });
    fleet.mockRejectedValue(new ServiceUnavailableException({ code: 'FABRIC_NOT_CONFIGURED', message: 'not configured' }));
    expect((await summaryOf(dana.token)).fleet).toEqual({ total: 0, online: 0, disabled: 0, stale: false, hosts: [] });
  });
});
