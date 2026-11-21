// The benchmark foundation (E44.1, #739) against a real, migrated and seeded database: a run with trigger `benchmark` is out of the
// owner's ordinary views and back with the filter; the two permissions are seeded for the organization administrator only; the two
// tables hold a benchmark and its trials, confined to their owner.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';
import { Prisma } from '@prisma/client';

import { BENCHMARK_SYSTEM_SETTINGS } from '../src/benchmark/benchmark.settings';
import { SUITE, seedFrom } from '../src/benchmark/suite/registry';
import { FleetService } from '../src/fleet/fleet.service';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { RunDeleteService } from '../src/tasks/run-delete.service';
import { TaskSummaryService } from '../src/tasks/task-summary.service';
import { TasksService } from '../src/tasks/tasks.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;

async function login(name: string, role: 'contributor' | 'viewer' | 'org_admin' = 'contributor') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
async function get<T>(token: string, url: string): Promise<T> {
  const res = await app.inject({ method: 'GET', url: `/api${url}`, headers: { authorization: `Bearer ${token}` } });
  expect([url, res.statusCode]).toEqual([url, 200]);
  return res.json<{ data: T }>().data;
}

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  jest.spyOn(app.get(FleetService), 'hosts').mockResolvedValue([]);
});
afterAll(async () => {
  await app?.close();
});

describe('a run with trigger benchmark', () => {
  let owner: { token: string; userId: string };
  let taskId = '';
  const id = { manual: '', failed: '', live: '', benchDone: '', benchFailed: '', benchLive: '', benchOnTask: '' };
  type Page = { items: { id: string; trigger: string }[]; nextCursor: string | null };
  type Counts = { total: number; live: number; byStatus: Record<string, number>; costUsd: number | null };

  beforeAll(async () => {
    owner = await login('bench-owner');
    const userId = owner.userId;
    taskId = (await prisma.task.create({ data: { userId, name: 'Fare watch', goal: 'Report the fare' } })).id;
    const now = Date.now();
    const run = async (data: Record<string, unknown>) => (await prisma.run.create({ data: { userId, goal: 'Report the fare', ...data } as never })).id;
    const done = (minutesAgo: number, extra: Record<string, unknown>) => ({
      status: 'succeeded',
      stopReason: 'finished',
      createdAt: new Date(now - (minutesAgo + 2) * 60_000),
      startedAt: new Date(now - (minutesAgo + 2) * 60_000),
      finishedAt: new Date(now - minutesAgo * 60_000),
      modelCalls: 2,
      stepCount: 4,
      ...extra,
    });
    // The owner's own work: two finished runs of a task and one live run without a task.
    id.manual = await run(done(30, { taskId, trigger: 'manual', costUsd: new Prisma.Decimal('0.10') }));
    id.failed = await run(done(20, { taskId, trigger: 'schedule', status: 'failed', stopReason: 'stalled', costUsd: new Prisma.Decimal('0.20') }));
    id.live = await run({ trigger: 'api', status: 'running', startedAt: new Date(now - 60_000), activeSince: new Date(now - 60_000) });
    // A benchmark's trial runs: finished, failed and live, without a task; and one that names the task, which the task's own numbers
    // must still leave out.
    id.benchDone = await run(done(10, { trigger: 'benchmark', origin: 'system', costUsd: new Prisma.Decimal('1.00') }));
    id.benchFailed = await run(done(8, { trigger: 'benchmark', origin: 'system', status: 'failed', stopReason: 'budget_cost', costUsd: new Prisma.Decimal('2.00') }));
    id.benchLive = await run({ trigger: 'benchmark', origin: 'system', status: 'running', startedAt: new Date(now - 30_000), activeSince: new Date(now - 30_000) });
    id.benchOnTask = await run(done(1, { taskId, trigger: 'benchmark', origin: 'system', status: 'failed', stopReason: 'stalled', costUsd: new Prisma.Decimal('4.00') }));
  });

  const ordinary = () => [id.manual, id.failed, id.live].sort();
  const benchmark = () => [id.benchDone, id.benchFailed, id.benchLive, id.benchOnTask].sort();

  it('is absent from the default run list and present with trigger=benchmark', async () => {
    const page = await get<Page>(owner.token, '/runs?envelope=1');
    expect(page.items.map((r) => r.id).sort()).toEqual(ordinary());
    expect((await get<{ id: string }[]>(owner.token, '/runs')).map((r) => r.id).sort()).toEqual(ordinary());
    // Another filter does not bring them back.
    expect((await get<Page>(owner.token, '/runs?envelope=1&taskId=none')).items.map((r) => r.id)).toEqual([id.live]);
    expect((await get<Page>(owner.token, `/runs?envelope=1&taskId=${taskId}`)).items.map((r) => r.id).sort()).toEqual([id.manual, id.failed].sort());
    expect((await get<Page>(owner.token, '/runs?envelope=1&state=live')).items.map((r) => r.id)).toEqual([id.live]);

    const only = await get<Page>(owner.token, '/runs?envelope=1&trigger=benchmark');
    expect(only.items.map((r) => r.id).sort()).toEqual(benchmark());
    expect(new Set(only.items.map((r) => r.trigger))).toEqual(new Set(['benchmark']));
    const both = await get<Page>(owner.token, '/runs?envelope=1&trigger=manual,benchmark');
    expect(both.items.map((r) => r.id).sort()).toEqual([id.manual, ...benchmark()].sort());
  });

  it('is still served by id: a benchmark page links to its trial runs', async () => {
    expect((await get<{ id: string; trigger: string }>(owner.token, `/runs/${id.benchDone}`)).trigger).toBe('benchmark');
  });

  it('is absent from the counts and their cost, and present with the filter', async () => {
    const counts = await get<Counts>(owner.token, '/runs/counts');
    expect(counts.total).toBe(3);
    expect(counts.live).toBe(1);
    expect(counts.byStatus).toMatchObject({ succeeded: 1, failed: 1, running: 1 });
    expect(counts.costUsd).toBeCloseTo(0.3, 6);
    const bench = await get<Counts>(owner.token, '/runs/counts?trigger=benchmark');
    expect(bench.total).toBe(4);
    expect(bench.byStatus).toMatchObject({ succeeded: 1, failed: 2, running: 1 });
    expect(bench.costUsd).toBeCloseTo(7, 6);
  });

  it('is not touched by a delete by filter that does not name it', async () => {
    const del = app.get(RunDeleteService);
    expect((await del.countMatching(owner.userId, {})).matched).toBe(2);
    expect((await del.countMatching(owner.userId, { trigger: ['benchmark'] })).matched).toBe(3);
  });

  it('is absent from the home summary: live runs, recent runs, the week and the run count', async () => {
    type Home = { liveRuns: { count: number; running: number; items: { id: string }[] }; recentRuns: { items: { id: string }[] }; week: { totals: { succeeded: number; failed: number; costUsd: number | null; stalled: number; budgetStops: number } }; counts: { runs: number }; upcoming: { failingCount: number } };
    const s = await get<Home>(owner.token, '/home/summary');
    expect(s.liveRuns.items.map((r) => r.id)).toEqual([id.live]);
    expect([s.liveRuns.count, s.liveRuns.running]).toEqual([1, 1]);
    expect(s.recentRuns.items.map((r) => r.id)).toEqual([id.failed, id.manual]);
    expect(s.week.totals).toMatchObject({ succeeded: 1, failed: 1, stalled: 1, budgetStops: 0 });
    expect(s.week.totals.costUsd).toBeCloseTo(0.3, 6);
    expect(s.counts.runs).toBe(3);
  });

  it('is absent from task statistics, the task summary and the task spend', async () => {
    const summaries = app.get(TaskSummaryService);
    const stats = await summaries.stats(owner.userId, taskId, 7, 'UTC');
    expect(stats.totals).toMatchObject({ runs: 2, succeeded: 1, failed: 1, cancelled: 0 });
    expect(stats.totals.costUsd).toBeCloseTo(0.3, 6);
    expect(stats.stopReasons).toEqual(expect.arrayContaining([{ reason: 'stalled', count: 1 }]));
    expect(stats.stopReasons.find((r) => r.reason === 'stalled')?.count).toBe(1);

    const one = await summaries.one(owner.userId, taskId);
    // The newest run of the task is the benchmark one; the summary still shows the owner's own last run and counts.
    expect(one.summary.lastRun?.id).toBe(id.failed);
    expect(one.summary.runCounts).toEqual({ total: 2, last7d: { succeeded: 1, failed: 1, cancelled: 0 } });
    expect(one.spend30d.runs).toBe(2);
    expect(one.spend30d.costUsd).toBeCloseTo(0.3, 6);
    const spend = (await app.get(TasksService).spendByTask(owner.userId, [taskId])).get(taskId)!;
    expect(spend.runs).toBe(2);
    expect(spend.costUsd).toBeCloseTo(0.3, 6);
  });
});

describe('the benchmark permissions and settings', () => {
  it('are seeded and granted to the organization administrator only', async () => {
    const perms = await prisma.permission.findMany({ where: { name: { in: ['benchmarks:read', 'benchmarks:run'] } }, select: { name: true, rolePermissions: { select: { role: { select: { name: true } } } } } });
    expect(perms.map((p) => p.name).sort()).toEqual(['benchmarks:read', 'benchmarks:run']);
    for (const p of perms) expect([p.name, p.rolePermissions.map((rp) => rp.role.name).filter((r) => r !== 'super_admin').sort()]).toEqual([p.name, ['org_admin']]);
  });

  it('serve the benchmark namespace of the system settings with its defaults', async () => {
    expect(await app.get(SystemSettingsService).getNamespace(BENCHMARK_SYSTEM_SETTINGS.key)).toEqual({ siteBaseUrl: '', defaultTrials: 3, defaultCapUsd: 5, trialTimeoutMinutes: 15 });
  });
});

describe('the benchmark tables', () => {
  it('hold a benchmark and its trials, confined to the owner, one row per cell, deleted together', async () => {
    const a = await login('bench-a', 'org_admin');
    const b = await login('bench-b', 'org_admin');
    const runId = (await prisma.run.create({ data: { userId: a.userId, goal: 'Trial', trigger: 'benchmark', origin: 'system' } })).id;
    const benchmark = await prisma.forUser({ userId: a.userId }).benchmark.create({
      data: { userId: a.userId, name: 'Nightly', suiteKey: SUITE.key, suiteVersion: SUITE.version, config: { challengeIds: ['nav-lookup'], policies: [{ ref: 'builtin:balanced', label: 'Balanced' }], trials: 2 }, appVersion: '0.0.0-test' },
    });
    expect([benchmark.status, Number(benchmark.spentUsd), benchmark.summary, benchmark.commit, benchmark.baselineId]).toEqual(['queued', 0, null, null, null]);
    const cell = (trialIndex: number) => ({ benchmarkId: benchmark.id, challengeId: 'nav-lookup', policyRef: 'builtin:balanced', policyLabel: 'Balanced', trialIndex, seed: seedFrom(benchmark.id, 'nav-lookup', 'builtin:balanced', trialIndex) });
    const first = await prisma.benchmarkTrial.create({ data: { ...cell(0), runId, tokenHash: 'a'.repeat(64), siteState: { orders: [] } } });
    const second = await prisma.benchmarkTrial.create({ data: cell(1) });
    expect([first.status, first.verdict, first.siteStateVersion, first.costUsd, second.tokenHash]).toEqual(['pending', null, 0, null, null]);
    expect(first.seed).not.toBe(second.seed);
    // One row per (benchmark, challenge, policy, trial), and a token hash names one trial.
    await expect(prisma.benchmarkTrial.create({ data: cell(1) })).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.benchmarkTrial.create({ data: { ...cell(2), tokenHash: 'a'.repeat(64) } })).rejects.toMatchObject({ code: 'P2002' });

    // Another administrator's scoped client does not see it.
    expect(await prisma.forUser({ userId: b.userId }).benchmark.findFirst({ where: { id: benchmark.id } })).toBeNull();
    expect(await prisma.forUser({ userId: a.userId }).benchmark.findFirst({ where: { id: benchmark.id }, select: { _count: { select: { trials: true } } } })).toEqual({ _count: { trials: 2 } });

    // A later benchmark compared with this one keeps living when the baseline is deleted.
    const later = await prisma.benchmark.create({ data: { userId: a.userId, name: 'After', suiteKey: SUITE.key, suiteVersion: SUITE.version, config: {}, appVersion: '0.0.0-test', baselineId: benchmark.id } });

    // Deleting the run (retention, the owner) leaves the trial and its copied metrics.
    await prisma.run.delete({ where: { id: runId } });
    expect((await prisma.benchmarkTrial.findUniqueOrThrow({ where: { id: first.id } })).runId).toBeNull();

    await prisma.benchmark.delete({ where: { id: benchmark.id } });
    expect(await prisma.benchmarkTrial.count({ where: { benchmarkId: benchmark.id } })).toBe(0);
    expect((await prisma.benchmark.findUniqueOrThrow({ where: { id: later.id } })).baselineId).toBeNull();
  });
});
