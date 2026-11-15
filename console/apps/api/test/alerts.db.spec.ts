// The console's alert rules on the platform alerts slice, against a real
// database: the three rules are created once, and each kind fires and
// resolves through the slice's own evaluation (pending → firing → resolved).
import { AlertsEvaluationService } from '@marinoscar/platform-api/alerts';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { setAlertSources, type AlertSources } from '../src/alerts/hexactra-alert-kinds';
import { HexactraAlertsService } from '../src/alerts/hexactra-alerts.service';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';

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
};

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
  it('creates its three rules once, enabled, and leaves existing ones alone', async () => {
    expect(await service.seed()).toBe(0); // bootstrap already created them
    for (const key of ['hexactra.host_offline', 'hexactra.schedule_failing', 'hexactra.run_budget']) {
      expect(await rule(key)).toMatchObject({ enabled: true });
    }
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
});
