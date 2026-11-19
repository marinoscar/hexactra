// The console's alert rules on the platform alerts slice, against a real
// database: the three rules are created once, and each kind fires and
// resolves through the slice's own evaluation (pending → firing → resolved).
// The run-budget cost threshold, the stall kind and the expensive-run kind
// (#408) are checked with fake sources and against real run rows.
import { AlertsEvaluationService } from '@marinoscar/platform-api/alerts';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { goalExcerpt, HEXACTRA_ALERT_KINDS, HEXACTRA_ALERT_RULES, setAlertSources, type AlertSources } from '../src/alerts/hexactra-alert-kinds';
import { HexactraAlertsService } from '../src/alerts/hexactra-alerts.service';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { RunDeleteService } from '../src/tasks/run-delete.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
let evaluation: AlertsEvaluationService;
let service: HexactraAlertsService;
/** Per-run ids: the database keeps incidents of earlier runs. */
const stamp = `${Date.now()}`;
const H1 = `h1-${stamp}`;
const S1 = `s1-${stamp}`;

const fake = {
  hosts: [] as Awaited<ReturnType<AlertSources['hosts']>>,
  hostsError: null as Error | null,
  schedules: [] as Awaited<ReturnType<AlertSources['failingSchedules']>>,
  usage: [] as Awaited<ReturnType<AlertSources['usage']>>,
  stalls: [] as Awaited<ReturnType<AlertSources['stalls']>>,
  expensive: [] as Awaited<ReturnType<AlertSources['expensiveRuns']>>,
};

/** A goal holding a fake secret (inside the first 80 characters and after them). */
const SECRET_GOAL = 'Sign in with password: FAKE-SECRET-MARKER-1 and token=FAKE-SECRET-MARKER-2, then compare every fare for next month and pick FAKE-SECRET-MARKER-3';

beforeAll(async () => {
  app = await createApp();
  await app.init();
  prisma = app.get(PrismaService);
  evaluation = app.get(AlertsEvaluationService, { strict: false });
  service = app.get(HexactraAlertsService, { strict: false });
  setAlertSources({
    hosts: async () => {
      if (fake.hostsError) throw fake.hostsError;
      return fake.hosts;
    },
    failingSchedules: async (min) => fake.schedules.filter((s) => s.consecutiveFailures >= min),
    usage: async () => fake.usage,
    stalls: async () => fake.stalls,
    expensiveRuns: async (over) => fake.expensive.filter((r) => r.costUsd > over),
  });
});
afterAll(async () => {
  await app?.close();
});

async function rule(key: string) {
  return prisma.alertRule.findUniqueOrThrow({ where: { key } });
}
async function incidents(key: string) {
  const r = await rule(key);
  return prisma.alertIncident.findMany({ where: { ruleId: r.id }, orderBy: { createdAt: 'asc' } });
}

describe('console alert rules', () => {
  it('creates its eight rules once by key (the expensive-run rule disabled), and leaves existing ones alone', async () => {
    expect(await service.seed()).toBe(0); // bootstrap already created them
    for (const key of ['hexactra.host_offline', 'hexactra.schedule_failing', 'hexactra.run_budget', 'hexactra.run_stalled']) {
      expect(await rule(key)).toMatchObject({ enabled: true });
    }
    expect(await rule('hexactra.run_stalled')).toMatchObject({ kind: HEXACTRA_ALERT_KINDS.RUN_STALLED, severity: 'warning', config: { windowHours: 24, minStalls: 3 } });
    expect(await rule('hexactra.run_cost')).toMatchObject({ kind: HEXACTRA_ALERT_KINDS.RUN_COST_SPIKE, enabled: false, config: { maxRunCostUsd: 10 } });
    expect(await prisma.alertRule.count({ where: { key: { in: HEXACTRA_ALERT_RULES.map((r) => r.key) } } })).toBe(8);
    // A deleted starter rule comes back once, by key, with its starter values.
    await prisma.alertRule.delete({ where: { key: 'hexactra.run_cost' } });
    expect(await service.seed()).toBe(1);
    expect(await service.seed()).toBe(0);
    expect(await rule('hexactra.run_cost')).toMatchObject({ enabled: false });
    await prisma.alertRule.update({ where: { key: 'hexactra.run_budget' }, data: { config: { windowHours: 24, maxTokens: 1000, maxBudgetStops: 2 } } });
    expect(await service.seed()).toBe(0);
    expect((await rule('hexactra.run_budget')).config).toMatchObject({ maxTokens: 1000 });
  });

  it('host offline: pending, firing after its hold, resolved when the host is back', async () => {
    const r = await rule('hexactra.host_offline');
    const t0 = new Date();
    fake.hosts = [{ id: H1, name: 'vps', online: false, draining: false }];
    await evaluation.evaluateRule(r, t0);
    expect((await incidents('hexactra.host_offline')).find((i) => i.labelsKey.includes(H1))?.state).toBe('pending');

    await evaluation.evaluateRule(r, new Date(t0.getTime() + 125_000));
    const firing = (await incidents('hexactra.host_offline')).find((i) => i.labelsKey.includes(H1))!;
    expect(firing.state).toBe('firing');
    expect(firing.summary).toMatch(/host vps is offline/);

    fake.hosts = [{ id: H1, name: 'vps', online: true, draining: false }];
    await evaluation.evaluateRule(r, new Date(t0.getTime() + 185_000));
    expect((await prisma.alertIncident.findUniqueOrThrow({ where: { id: firing.id } })).state).toBe('resolved');
  });

  it('host offline: a draining host is left out; an unreachable fabric fires', async () => {
    const r = await rule('hexactra.host_offline');
    fake.hosts = [{ id: 'h2', name: 'drained', online: false, draining: true }];
    const obs = await evaluation.observe(r);
    expect(obs.filter((o) => o.breached)).toEqual([]);
    fake.hostsError = new Error('connect ECONNREFUSED');
    expect((await evaluation.observe(r)).find((o) => o.labels.fabric)?.breached).toBe(true);
    fake.hostsError = null;
  });

  it('schedule failing: fires at the threshold and resolves when the schedule recovers', async () => {
    const r = await rule('hexactra.schedule_failing');
    fake.schedules = [{ id: S1, taskName: 'Nightly fares', consecutiveFailures: 3 }];
    await evaluation.evaluateRule(r);
    const firing = (await incidents('hexactra.schedule_failing')).find((i) => i.labelsKey.includes(S1))!;
    expect(firing.state).toBe('firing');
    expect(firing.summary).toMatch(/"Nightly fares" failed 3 runs in a row/);
    fake.schedules = [];
    await evaluation.evaluateRule(r);
    expect((await prisma.alertIncident.findUniqueOrThrow({ where: { id: firing.id } })).state).toBe('resolved');
  });

  it('run budget: fires over the token limit or on repeated budget stops, then resolves', async () => {
    const r = await rule('hexactra.run_budget');
    fake.usage = [
      { userId: `u-tokens-${stamp}`, tokens: 5000, budgetStops: 0, runs: 4 },
      { userId: `u-stops-${stamp}`, tokens: 10, budgetStops: 2, runs: 2 },
      { userId: `u-fine-${stamp}`, tokens: 10, budgetStops: 0, runs: 1 },
    ];
    await evaluation.evaluateRule(r);
    const open = (await incidents('hexactra.run_budget')).filter((i) => i.state === 'firing');
    expect(open.some((i) => i.labelsKey.includes(`u-tokens-${stamp}`))).toBe(true);
    expect(open.some((i) => i.labelsKey.includes(`u-stops-${stamp}`))).toBe(true);
    expect(open.some((i) => i.labelsKey.includes(`u-fine-${stamp}`))).toBe(false);
    fake.usage = [];
    await evaluation.evaluateRule(r);
    expect((await incidents('hexactra.run_budget')).filter((i) => i.state === 'firing')).toEqual([]);
  });

  it('run budget: breaches over the cost threshold of the window, "≥" when part is unpriced', async () => {
    const r = await rule('hexactra.run_budget');
    await prisma.alertRule.update({ where: { id: r.id }, data: { config: { windowHours: 24, maxTokens: 1_000_000, maxCostUsd: 5, maxBudgetStops: 50 } } });
    try {
      fake.usage = [
        { userId: `u-cost-${stamp}`, tokens: 10, budgetStops: 0, runs: 3, costUsd: 7.5, costKnown: false },
        { userId: `u-cheap-${stamp}`, tokens: 10, budgetStops: 0, runs: 3, costUsd: 4.99, costKnown: true },
      ];
      const obs = await evaluation.observe(await rule('hexactra.run_budget'));
      const over = obs.find((o) => o.labels['user.id'] === `u-cost-${stamp}`)!;
      expect(over.breached).toBe(true);
      expect(over.summary).toContain('≥ $7.50 spent (limit $5.00)');
      expect(obs.find((o) => o.labels['user.id'] === `u-cheap-${stamp}`)?.breached).toBe(false);

      // Null (the starter value) checks no cost at all.
      await prisma.alertRule.update({ where: { id: r.id }, data: { config: { windowHours: 24, maxTokens: 1_000_000, maxCostUsd: null, maxBudgetStops: 50 } } });
      expect((await evaluation.observe(await rule('hexactra.run_budget'))).some((o) => o.breached)).toBe(false);
    } finally {
      fake.usage = [];
      await prisma.alertRule.update({ where: { id: r.id }, data: { config: r.config ?? {} } });
    }
  });

  it('runs stalling: fires at minStalls, names the task and run, and resolves', async () => {
    const r = await rule('hexactra.run_stalled');
    const user = `u-stall-${stamp}`;
    const latest = { runId: `r-stall-${stamp}`, taskName: 'Nightly fares', goal: SECRET_GOAL };
    fake.stalls = [{ userId: user, stalls: 2, latest }];
    expect((await evaluation.observe(r)).find((o) => o.labels['user.id'] === user)?.breached).toBe(false);

    fake.stalls = [{ userId: user, stalls: 3, latest }];
    await evaluation.evaluateRule(r);
    const firing = (await incidents('hexactra.run_stalled')).find((i) => i.labelsKey.includes(user))!;
    expect(firing.state).toBe('firing');
    expect(firing.summary).toMatch(/3 runs ended stuck in 24 h \(latest: run r-stall- of task "Nightly fares"\)/);
    fake.stalls = [];
    await evaluation.evaluateRule(r);
    expect((await prisma.alertIncident.findUniqueOrThrow({ where: { id: firing.id } })).state).toBe('resolved');
  });

  it('expensive run: one run over maxRunCostUsd fires (when enabled), naming the run', async () => {
    const r = await prisma.alertRule.update({ where: { key: 'hexactra.run_cost' }, data: { enabled: true, config: { maxRunCostUsd: 10, windowHours: 24 } } });
    try {
      const runId = `r-cost-${stamp}-0000000000`;
      fake.expensive = [
        { runId, userId: `u-big-${stamp}`, taskName: null, goal: SECRET_GOAL, costUsd: 12.345, costKnown: true },
        { runId: `r-small-${stamp}`, userId: `u-big-${stamp}`, taskName: 'Small', goal: 'Look', costUsd: 9.99, costKnown: true },
      ];
      await evaluation.evaluateRule(r);
      const open = (await incidents('hexactra.run_cost')).filter((i) => i.state === 'firing');
      expect(open).toHaveLength(1);
      expect(open[0]!.labelsKey).toContain(runId);
      expect(open[0]!.summary).toMatch(/run r-cost-1?\d* \("Sign in with password: \[redacted\].*"\) cost \$12\.35 \(limit \$10\.00\)/);
      // No secret material: not the marker, and never the goal past 80 characters.
      expect(open[0]!.summary).not.toContain('FAKE-SECRET-MARKER');
      fake.expensive = [];
      await evaluation.evaluateRule(r);
      expect((await incidents('hexactra.run_cost')).filter((i) => i.state === 'firing')).toEqual([]);
    } finally {
      fake.expensive = [];
      await prisma.alertRule.update({ where: { key: 'hexactra.run_cost' }, data: { enabled: false } });
    }
  });

  it('no secret material in a goal excerpt: masked, and cut to 80 characters', () => {
    const excerpt = goalExcerpt(SECRET_GOAL);
    expect(excerpt.length).toBeLessThanOrEqual(80);
    expect(excerpt).not.toContain('FAKE-SECRET-MARKER');
    // A fake token, assembled at runtime so secret scanners do not read the fixture as a credential.
    const fakeToken = ['abcd', 'efgh', 'ijkl', 'mnop'].join('');
    expect(goalExcerpt(`Use Authorization: Bearer ${fakeToken} to call it`)).not.toContain(fakeToken);
    expect(goalExcerpt('Open the page with key sk0123456789abcdefghijklmnopqrstuv')).not.toContain('sk0123456789');
    expect(goalExcerpt('Find the cheapest fare')).toBe('Find the cheapest fare');
  });
});

describe('console alert sources, from real run rows (#408)', () => {
  it('sum cost per user, count stalls with their latest run, and find expensive runs', async () => {
    const owner = await prisma.user.create({ data: { email: `alerts-src-${stamp}@example.test`, displayName: 'Person A' } });
    const db = prisma.forUser({ userId: owner.id });
    const task = await db.task.create({ data: { userId: owner.id, name: 'Fares', goal: SECRET_GOAL } });
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
    await db.run.create({ data: { userId: owner.id, taskId: task.id, goal: SECRET_GOAL, status: 'failed', stopReason: 'stalled', costUsd: 1, createdAt: at(30) } });
    const lastStall = await db.run.create({ data: { userId: owner.id, taskId: task.id, goal: SECRET_GOAL, status: 'failed', stopReason: 'stalled', costUsd: 2, createdAt: at(10) } });
    await db.run.create({ data: { userId: owner.id, goal: 'One-off', status: 'succeeded', stopReason: 'finished', costUsd: 11.5, costKnown: false, createdAt: at(5) } });
    await db.run.create({ data: { userId: owner.id, goal: 'Old', status: 'failed', stopReason: 'stalled', costUsd: 50, createdAt: at(60 * 48) } });

    const since = new Date(Date.now() - 24 * 3_600_000);
    const usage = (await service.sources.usage(since)).find((u) => u.userId === owner.id);
    expect(usage).toMatchObject({ runs: 3, costUsd: 14.5, costKnown: false });

    const stalls = (await service.sources.stalls(since)).find((u) => u.userId === owner.id);
    expect(stalls).toEqual({ userId: owner.id, stalls: 2, latest: { runId: lastStall.id, taskName: 'Fares', goal: SECRET_GOAL } });

    const expensive = (await service.sources.expensiveRuns(10, since)).filter((r) => r.userId === owner.id);
    expect(expensive).toEqual([expect.objectContaining({ taskName: null, goal: 'One-off', costUsd: 11.5, costKnown: false })]);
  });

  it('a deleted budget-stopped run no longer counts: its stop, its tokens and its cost leave the window (#421)', async () => {
    const owner = await prisma.user.create({ data: { email: `alerts-del-${stamp}@example.test`, displayName: 'Person B' } });
    const db = prisma.forUser({ userId: owner.id });
    const stopped = { userId: owner.id, goal: 'Compare fares', status: 'failed' as const, inputTokens: 900, outputTokens: 100, modelCalls: 4 };
    const first = await db.run.create({ data: { ...stopped, stopReason: 'budget_cost', costUsd: 3 } });
    await db.run.create({ data: { ...stopped, stopReason: 'budget_actions', costUsd: 1 } });
    const live = await db.run.create({ data: { ...stopped, status: 'running', costUsd: 0.5 } });
    const since = new Date(Date.now() - 3_600_000);
    const usage = async () => (await service.sources.usage(since)).find((u) => u.userId === owner.id);
    expect(await usage()).toMatchObject({ runs: 3, budgetStops: 2, tokens: 3000, costUsd: 4.5 });

    const runs = app.get(RunDeleteService, { strict: false });
    await runs.deleteOne(owner.id, first.id);
    expect(await usage()).toMatchObject({ runs: 2, budgetStops: 1, tokens: 2000, costUsd: 1.5 });
    // Every finished run of the user: the live one stays, and is all that still counts.
    expect(await runs.deleteMatching(owner.id, {})).toMatchObject({ deleted: 1, costUsd: 1 });
    expect(await usage()).toMatchObject({ runs: 1, budgetStops: 0, tokens: 1000, costUsd: 0.5 });
    await expect(runs.deleteOne(owner.id, live.id)).rejects.toMatchObject({ response: { code: 'RUN_LIVE' } });
  });
});
