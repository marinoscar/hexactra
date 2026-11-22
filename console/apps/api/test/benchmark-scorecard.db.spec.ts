// The scorecard and the comparison (E44.4, #742) against a real, migrated database: the two routes, the cache in `Benchmark.summary`
// (written where a benchmark ends: the last pass, and a cancel), a live scorecard while it runs, a deleted run changing nothing, and a
// comparison refused across suite versions. The benchmarks are written straight into the database (test/support/benchmark-fixtures.ts).
//
// The job worker is off (`JOBS_WORKER_MODE=off`): the spec runs the passes itself.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Job } from '@marinoscar/platform-api/jobs';
import { Prisma } from '@prisma/client';

import { BENCHMARK_ADVANCE_JOB, BenchmarkAdvanceHandler } from '../src/benchmark/benchmark.jobs';
import { BenchmarksService } from '../src/benchmark/benchmarks.service';
import { SCORECARD_FORMAT, SCORECARD_VERSION, type BenchmarkComparison, type Scorecard } from '../src/benchmark/scorecard.schemas';
import { SUITE } from '../src/benchmark/suite/registry';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { createGradedBenchmark } from './support/benchmark-fixtures';

let app: NestFastifyApplication;
let prisma: PrismaService;
let service: BenchmarksService;
let handler: BenchmarkAdvanceHandler;
const stamp = `${Date.now()}`;
const created: string[] = [];
const workerMode = process.env.JOBS_WORKER_MODE;

async function login(name: string, role = 'org_admin'): Promise<{ id: string; headers: { authorization: string } }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const headers = { authorization: `Bearer ${token}` };
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers });
  return { id: me.json<{ data: { id: string } }>().data.id, headers };
}
const call = (headers: Record<string, string>, url: string) => app.inject({ method: 'GET', url: `/api/benchmarks${url}`, headers });
async function read<T>(headers: Record<string, string>, url: string): Promise<T> {
  const res = await call(headers, url);
  expect([url, res.statusCode]).toEqual([url, 200]);
  return res.json<{ data: T }>().data;
}
const summaryOf = async (id: string) => (await prisma.benchmark.findUniqueOrThrow({ where: { id } })).summary as unknown as Scorecard | null;
const pass = (benchmarkId: string) => handler.process({ id: 'job-in-test', payload: { benchmarkId } } as unknown as Job);
const track = <T extends { id: string }>(b: T): T => {
  created.push(b.id);
  return b;
};
/** A scorecard without the time it was computed at. */
const timeless = (s: Scorecard) => ({ ...s, computedAt: '' });

beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  service = app.get(BenchmarksService);
  handler = app.get(BenchmarkAdvanceHandler);
});
afterAll(async () => {
  if (created.length) {
    await prisma.job.deleteMany({ where: { type: BENCHMARK_ADVANCE_JOB, subjectId: { in: created } } });
    await prisma.benchmark.deleteMany({ where: { id: { in: created } } });
  }
  await app?.close();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
});

describe('GET /api/benchmarks/{id}/scorecard', () => {
  it('scores a finished benchmark from its trials and caches it in the summary', async () => {
    const admin = await login('score-read');
    // Economy fails nav-lookup once, claiming success, with an unpriced call.
    const b = track(await createGradedBenchmark(prisma, admin.id, { result: (c) => (c.policyRef === 'builtin:economy' && c.challengeId === 'nav-lookup' && c.trialIndex === 0 ? { verdict: 'fail', claimedSuccess: true, costKnown: false } : undefined) }));
    expect(await summaryOf(b.id)).toBeNull();

    const card = await read<Scorecard>(admin.headers, `/${b.id}/scorecard`);
    expect(card).toMatchObject({ format: SCORECARD_FORMAT, version: SCORECARD_VERSION, live: false, status: 'completed', k: 3, suiteKey: SUITE.key });
    // 12 trials at 0.01, 12 000 in, 600 out and 4 000 cached each.
    expect(card.totals).toMatchObject({ costUsd: 0.12, costKnown: false, inputTokens: 144_000, outputTokens: 7_200, cachedInputTokens: 48_000, totalTokens: 151_200, modelCalls: 48 });
    expect(card.ranking.map((r) => [r.rank, r.ref, r.successRate, r.costPerSuccessUsd, r.costKnown])).toEqual([
      [1, 'builtin:balanced', 1, 0.01, true],
      [2, 'builtin:economy', 5 / 6, 0.012, false],
    ]);
    const economy = card.policies.find((p) => p.ref === 'builtin:economy')!;
    expect(economy.metrics).toMatchObject({ falseSuccess: { k: 1, n: 6 }, passAllK: { challenges: 2, allPassed: 1 }, models: ['fixture:builtin:economy'], tokens: { total: 75_600, perSuccess: 15_120 } });
    expect(economy.categories.map((c) => [c.category, c.metrics.successRate.k, c.metrics.successRate.n, c.metrics.cost.known])).toEqual([['navigation', 2, 3, false], ['forms', 3, 3, true]]);
    expect(card.matrix[0]).toMatchObject({ challengeId: 'nav-lookup', cells: [{ policyRef: 'builtin:economy', passes: 2, judged: 3, verdicts: ['fail', 'pass', 'pass'] }, { policyRef: 'builtin:balanced', passes: 3 }] });

    const cached = await summaryOf(b.id);
    expect(cached).toEqual(card);
    // The next read is the cached one, even when a trial row changes behind it.
    await prisma.benchmarkTrial.updateMany({ where: { benchmarkId: b.id }, data: { costUsd: 9 } });
    expect(await read<Scorecard>(admin.headers, `/${b.id}/scorecard`)).toEqual(card);
    // A summary of another format version is recomputed.
    await prisma.benchmark.update({ where: { id: b.id }, data: { summary: { ...card, version: SCORECARD_VERSION + 1 } } });
    expect((await read<Scorecard>(admin.headers, `/${b.id}/scorecard`)).policies[0]!.metrics.cost.totalUsd).toBe(54);
  });

  it('a benchmark with no judged trial has an empty scorecard, not an error', async () => {
    const admin = await login('score-empty');
    const b = track(await createGradedBenchmark(prisma, admin.id, { trials: 1, result: () => ({ verdict: 'skipped', failureReason: 'cancelled' }), status: 'cancelled' }));
    const card = await read<Scorecard>(admin.headers, `/${b.id}/scorecard`);
    expect(card.totals).toMatchObject({ costUsd: 0, totalTokens: 0, counts: { total: 4, judged: 0, skipped: 4 } });
    expect(card.policies.map((p) => p.metrics.successRate.value)).toEqual([null, null]);
  });

  it('is computed live while the benchmark runs, and never cached then', async () => {
    const admin = await login('score-live');
    const b = track(await createGradedBenchmark(prisma, admin.id, { status: 'running', trials: 1 }));
    await prisma.benchmarkTrial.updateMany({ where: { benchmarkId: b.id, challengeId: 'form-multistep' }, data: { status: 'pending', verdict: null, costUsd: null, inputTokens: null, outputTokens: null, cachedInputTokens: null, modelCalls: null } });
    const card = await read<Scorecard>(admin.headers, `/${b.id}/scorecard`);
    expect(card).toMatchObject({ live: true, status: 'running', totals: { counts: { total: 4, judged: 2, unfinished: 2 } } });
    expect(card.matrix[1]!.cells.map((c) => c.verdicts)).toEqual([[null], [null]]);
    expect(await summaryOf(b.id)).toBeNull();
  });

  it("is another administrator's benchmark: not found", async () => {
    const [owner, other] = [await login('score-owner'), await login('score-other')];
    const b = track(await createGradedBenchmark(prisma, owner.id, { trials: 1 }));
    expect((await call(other.headers, `/${b.id}/scorecard`)).statusCode).toBe(404);
    const viewer = await login('score-viewer', 'contributor');
    expect((await call(viewer.headers, `/${b.id}/scorecard`)).statusCode).toBe(403);
  });

  it('deleting the runs of a finished benchmark leaves its scorecard unchanged', async () => {
    const admin = await login('score-runs');
    const runIds: string[] = [];
    for (let i = 0; i < 12; i++) runIds.push((await prisma.run.create({ data: { userId: admin.id, goal: 'Fixture trial', trigger: 'benchmark', status: 'succeeded', stopReason: 'finished' } as never })).id);
    let next = 0;
    const b = track(await createGradedBenchmark(prisma, admin.id, { result: (c) => ({ runId: runIds[next++]!, ...(c.trialIndex === 2 ? { verdict: 'fail' as const, costKnown: false } : {}) }) }));
    expect(await prisma.benchmarkTrial.count({ where: { benchmarkId: b.id, runId: { not: null } } })).toBe(12);

    const before = await read<Scorecard>(admin.headers, `/${b.id}/scorecard`);
    await prisma.run.deleteMany({ where: { id: { in: runIds } } });
    expect(await prisma.benchmarkTrial.count({ where: { benchmarkId: b.id, runId: { not: null } } })).toBe(0);
    expect(await read<Scorecard>(admin.headers, `/${b.id}/scorecard`)).toEqual(before);
    // And recomputed from the trials alone, without the cache, it is the same.
    await prisma.benchmark.update({ where: { id: b.id }, data: { summary: Prisma.DbNull } });
    expect(await summaryOf(b.id)).toBeNull();
    expect(timeless(await read<Scorecard>(admin.headers, `/${b.id}/scorecard`))).toEqual(timeless(before));
  });
});

describe('the summary is written where a benchmark ends', () => {
  it('by the pass that finds nothing left to run', async () => {
    const admin = await login('score-finish');
    const b = track(await createGradedBenchmark(prisma, admin.id, { status: 'running', trials: 1 }));
    await pass(b.id);
    const row = await prisma.benchmark.findUniqueOrThrow({ where: { id: b.id } });
    expect(row.status).toBe('completed');
    expect(await summaryOf(b.id)).toMatchObject({ format: SCORECARD_FORMAT, live: false, status: 'completed', totals: { counts: { judged: 4, pass: 4 } } });
  });

  it('by a cancel when nothing was running, and by the pass that ends the trial that was', async () => {
    const admin = await login('score-cancel');
    const idle = track(await createGradedBenchmark(prisma, admin.id, { status: 'running', trials: 1 }));
    await service.cancel({ id: admin.id, activeOrgId: null }, idle.id);
    expect(await summaryOf(idle.id)).toMatchObject({ status: 'cancelled', live: false });

    const busy = track(await createGradedBenchmark(prisma, admin.id, { status: 'running', trials: 1 }));
    // A trial claimed but whose run was never created: the cancel leaves it to the next pass.
    await prisma.benchmarkTrial.updateMany({ where: { benchmarkId: busy.id, challengeId: 'form-multistep', policyRef: 'builtin:economy' }, data: { status: 'running', verdict: null, finishedAt: null } });
    await service.cancel({ id: admin.id, activeOrgId: null }, busy.id);
    expect(await summaryOf(busy.id)).toBeNull();
    expect(await read<Scorecard>(admin.headers, `/${busy.id}/scorecard`)).toMatchObject({ live: true, status: 'cancelled' });
    expect(await summaryOf(busy.id)).toBeNull();
    await pass(busy.id);
    expect(await summaryOf(busy.id)).toMatchObject({ status: 'cancelled', live: false, totals: { counts: { judged: 3, skipped: 1, unfinished: 0 } } });
  });
});

describe('GET /api/benchmarks/{id}/compare', () => {
  it('reports deltas, the challenges that flipped, and both versions and commits', async () => {
    const admin = await login('score-compare');
    // The baseline: Economy failed nav-lookup every time. Its second policy had another ref and the label "Balanced".
    const baseline = track(
      await createGradedBenchmark(prisma, admin.id, {
        appVersion: '1.0.0',
        commit: 'aaaaaaa',
        policies: [{ ref: 'builtin:economy', label: 'Economy' }, { ref: 'builtin:thorough', label: 'Balanced' }],
        result: (c) => (c.policyRef === 'builtin:economy' && c.challengeId === 'nav-lookup' ? { verdict: 'fail', failureReason: 'gave_up', claimedSuccess: false } : undefined),
      }),
    );
    const current = track(await createGradedBenchmark(prisma, admin.id, { appVersion: '1.1.0', commit: 'bbbbbbb', result: (c) => (c.policyRef === 'builtin:balanced' && c.challengeId === 'form-multistep' && c.trialIndex === 1 ? { verdict: 'fail' } : undefined) }));

    const cmp = await read<BenchmarkComparison>(admin.headers, `/${current.id}/compare?baseline=${baseline.id}`);
    expect([cmp.current.appVersion, cmp.current.commit, cmp.baseline.appVersion, cmp.baseline.commit]).toEqual(['1.1.0', 'bbbbbbb', '1.0.0', 'aaaaaaa']);
    expect(cmp.policies.map((p) => [p.ref, p.baselineRef, p.matchedBy])).toEqual([['builtin:economy', 'builtin:economy', 'ref'], ['builtin:balanced', 'builtin:thorough', 'label']]);
    expect(cmp.flipped.map((f) => [f.challengeId, f.policyRef, f.baseline.outcome, f.current.outcome, f.direction])).toEqual([
      ['nav-lookup', 'builtin:economy', 'fail', 'pass', 'better'],
      ['form-multistep', 'builtin:balanced', 'pass', 'mixed', 'worse'],
    ]);
    const economy = Object.fromEntries(cmp.policies[0]!.deltas.map((d) => [d.metric, d]));
    // 6/6 against 3/6: [0.610, 1] and [0.188, 0.812] overlap.
    expect(economy.successRate).toMatchObject({ current: 1, baseline: 0.5, delta: 0.5, withinNoise: true });
    expect(economy.costPerSuccessUsd).toMatchObject({ current: 0.01, baseline: 0.02, delta: -0.01, improved: true, atLeast: false });
    expect(cmp.totals.map((d) => [d.metric, d.delta])).toEqual([['totalCostUsd', 0], ['totalTokens', 0], ['inputTokens', 0], ['outputTokens', 0], ['cachedInputTokens', 0]]);
  });

  it('carries the input, output and cached input token deltas, for the whole benchmark and per policy (#829)', async () => {
    const admin = await login('score-compare-split');
    // One trial per cell, two challenges, two policies; every default trial is 12,000 input, 600 output, 4,000 cached input.
    const baseline = track(await createGradedBenchmark(prisma, admin.id, { trials: 1 }));
    const current = track(await createGradedBenchmark(prisma, admin.id, { trials: 1, result: (c) => (c.policyRef === 'builtin:economy' ? { inputTokens: 10_000, outputTokens: 900, cachedInputTokens: 1_000 } : undefined) }));

    const cmp = await read<BenchmarkComparison>(admin.headers, `/${current.id}/compare?baseline=${baseline.id}`);
    const split = (ds: BenchmarkComparison['totals']) => Object.fromEntries(ds.filter((d) => ['inputTokens', 'outputTokens', 'cachedInputTokens', 'totalTokens'].includes(d.metric)).map((d) => [d.metric, [d.baseline, d.current, d.delta, d.improved]]));
    // Economy: 2 x (12,000 / 600 / 4,000) before, 2 x (10,000 / 900 / 1,000) now.
    expect(split(cmp.policies[0]!.deltas)).toEqual({
      totalTokens: [25_200, 21_800, -3_400, true],
      inputTokens: [24_000, 20_000, -4_000, true],
      outputTokens: [1_200, 1_800, 600, false],
      cachedInputTokens: [8_000, 2_000, -6_000, true],
    });
    expect(split(cmp.policies[1]!.deltas)).toEqual({ totalTokens: [25_200, 25_200, 0, null], inputTokens: [24_000, 24_000, 0, null], outputTokens: [1_200, 1_200, 0, null], cachedInputTokens: [8_000, 8_000, 0, null] });
    // The whole benchmark adds Balanced's unchanged 24,000 / 1,200 / 8,000 to both sides.
    expect(split(cmp.totals)).toEqual({
      totalTokens: [50_400, 47_000, -3_400, true],
      inputTokens: [48_000, 44_000, -4_000, true],
      outputTokens: [2_400, 3_000, 600, false],
      cachedInputTokens: [16_000, 10_000, -6_000, true],
    });
  });

  it('refuses a baseline on another suite version, naming both', async () => {
    const admin = await login('score-mismatch');
    const v1 = track(await createGradedBenchmark(prisma, admin.id, { trials: 1 }));
    const v2 = track(await createGradedBenchmark(prisma, admin.id, { trials: 1, suiteVersion: SUITE.version + 1 }));
    const res = await call(admin.headers, `/${v2.id}/compare?baseline=${v1.id}`);
    expect(res.statusCode).toBe(409);
    const body = res.json<{ code: string; message: string; details: unknown }>();
    expect(body.code).toBe('BENCHMARK_SUITE_MISMATCH');
    expect(body.message).toContain(`version ${SUITE.version + 1}`);
    expect(body.message).toContain(`version ${SUITE.version}`);
    expect(body.details).toEqual({ benchmark: { suiteKey: SUITE.key, suiteVersion: SUITE.version + 1 }, baseline: { suiteKey: SUITE.key, suiteVersion: SUITE.version } });
    expect((await call(admin.headers, `/${v2.id}/compare?baseline=not-a-uuid`)).statusCode).toBe(400);
    // Suite 1 (the first ten challenges) against suite 2 (#745), both ways.
    const one = track(await createGradedBenchmark(prisma, admin.id, { trials: 1, suiteVersion: 1 }));
    const two = track(await createGradedBenchmark(prisma, admin.id, { trials: 1, suiteVersion: 2 }));
    for (const [cur, base, a, b] of [[two, one, 2, 1], [one, two, 1, 2]] as const) {
      const r = await call(admin.headers, `/${cur.id}/compare?baseline=${base.id}`);
      expect(r.statusCode).toBe(409);
      expect(r.json<{ code: string; details: unknown }>()).toMatchObject({ code: 'BENCHMARK_SUITE_MISMATCH', details: { benchmark: { suiteVersion: a }, baseline: { suiteVersion: b } } });
    }
    expect((await call(admin.headers, `/${v2.id}/compare?baseline=00000000-0000-4000-8000-000000000000`)).statusCode).toBe(404);
  });
});
