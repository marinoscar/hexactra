// A trial's recording status (#846) against a real, migrated database: `GET /api/benchmarks/{id}/trials` carries the trial run's
// recording (ready, processing, recording, failed, none, run removed), read in the same query as the trials (never one query per trial),
// only for a viewer with `runs:read`; the JSON and CSV exports carry the status, never the video or its key.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { CSV_COLUMNS } from '../src/benchmark/benchmark-report';
import type { BenchmarkReport } from '../src/benchmark/benchmark-report.schemas';
import { canSeeRecordings } from '../src/benchmark/benchmarks.controller';
import type { BenchmarkTrialView } from '../src/benchmark/benchmarks.schemas';
import { BenchmarksService } from '../src/benchmark/benchmarks.service';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { parseCsv } from './helpers/csv-parse';
import { createGradedBenchmark } from './support/benchmark-fixtures';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;
const created: string[] = [];

async function login(name: string): Promise<{ id: string; headers: { authorization: string } }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `trial-rec-${name}-${stamp}@example.test`, role: 'org_admin' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const headers = { authorization: `Bearer ${token}` };
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers });
  return { id: me.json<{ data: { id: string } }>().data.id, headers };
}

/** The recording each trial run gets, in run order; `removed`: the run is deleted after the benchmark ends. */
const PLAN = ['ready', 'processing', 'recording', 'failed', 'none', 'removed', 'ready', 'none'] as const;

/** A finished benchmark of 8 trials (2 challenges x 2 policies x 2), each with a run, recorded as `PLAN` says. */
async function seeded(userId: string) {
  const runIds: string[] = [];
  for (const [i, plan] of PLAN.entries()) {
    const run = await prisma.run.create({ data: { userId, goal: `Trial ${i}`, trigger: 'benchmark', status: 'succeeded', stopReason: 'finished', recordVideo: plan !== 'none' } as never });
    runIds.push(run.id);
    if (plan !== 'none' && plan !== 'removed') {
      await prisma.runRecording.create({
        data: { runId: run.id, userId, status: plan, durationMs: 42_000 + i, bytes: 1000, partCount: 1, objectKey: plan === 'ready' ? `run-recordings/${userId}/${run.id}/recording.webm` : null },
      });
    }
  }
  let next = 0;
  const b = await createGradedBenchmark(prisma, userId, { trials: 2, result: () => ({ runId: runIds[next++]! }) });
  created.push(b.id);
  await prisma.run.delete({ where: { id: runIds[PLAN.indexOf('removed')]! } });
  return { id: b.id, runIds };
}

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  if (created.length) await prisma.benchmark.deleteMany({ where: { id: { in: created } } });
  await app?.close();
});

describe('a trial run recording (#846)', () => {
  let admin: { id: string; headers: { authorization: string } };
  let bench: { id: string; runIds: string[] };

  beforeAll(async () => {
    admin = await login('owner');
    bench = await seeded(admin.id);
  });

  it('lists each trial with its run recording: ready with its length, processing, recording, failed, none, and none once the run is removed', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/benchmarks/${bench.id}/trials`, headers: admin.headers });
    expect(res.statusCode).toBe(200);
    const items = res.json<{ data: { items: BenchmarkTrialView[] } }>().data.items;
    const byRun = (i: number) => items.find((t) => t.runId === bench.runIds[i]);
    expect(byRun(0)!.recording).toEqual({ status: 'ready', durationMs: 42_000 });
    expect(byRun(1)!.recording).toEqual({ status: 'processing', durationMs: null });
    expect(byRun(2)!.recording).toEqual({ status: 'recording', durationMs: null });
    expect(byRun(3)!.recording).toEqual({ status: 'failed', durationMs: null });
    expect(byRun(4)!.recording).toBeNull();
    expect(byRun(5)).toBeUndefined();
    expect(byRun(6)!.recording).toEqual({ status: 'ready', durationMs: 42_006 });
    // The removed run's trial keeps its metrics, with no run and no recording.
    const removed = items.filter((t) => t.runId === null);
    expect(removed).toHaveLength(1);
    expect(removed[0]!.recording).toBeNull();
    // Never the video's key or a link to it.
    expect(res.body).not.toMatch(/run-recordings\/|recording\.webm|objectKey/);
  });

  it('reads the recordings in the same query as the trials, never one query per trial', async () => {
    const trials = jest.spyOn(prisma.benchmarkTrial, 'findMany');
    const recordings = (['findMany', 'findFirst', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow'] as const).map((m) => jest.spyOn(prisma.runRecording, m));
    const runs = (['findMany', 'findFirst', 'findUnique'] as const).map((m) => jest.spyOn(prisma.run, m));
    try {
      const res = await app.inject({ method: 'GET', url: `/api/benchmarks/${bench.id}/trials`, headers: admin.headers });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ data: { items: BenchmarkTrialView[] } }>().data.items.filter((t) => t.recording)).toHaveLength(5);
      expect(trials).toHaveBeenCalledTimes(1);
      for (const spy of [...recordings, ...runs]) expect(spy).not.toHaveBeenCalled();
    } finally {
      trials.mockRestore();
      for (const spy of [...recordings, ...runs]) spy.mockRestore();
    }
  });

  it('gives no recording to a viewer without runs:read', async () => {
    expect(canSeeRecordings({ permissions: ['benchmarks:read', 'runs:read'] })).toBe(true);
    expect(canSeeRecordings({ permissions: ['benchmarks:read'] })).toBe(false);
    expect(canSeeRecordings({})).toBe(false);
    const service = app.get(BenchmarksService);
    const hidden = await service.trials(admin.id, bench.id, {}, { recordings: false });
    expect(hidden.items.every((t) => t.recording === null)).toBe(true);
    const shown = await service.trials(admin.id, bench.id, {}, { recordings: true });
    expect(shown.items.filter((t) => t.recording)).toHaveLength(5);
  });

  it('exports the recording status in the JSON report and the CSV, never the video', async () => {
    const json = await app.inject({ method: 'GET', url: `/api/benchmarks/${bench.id}/export?format=json`, headers: admin.headers });
    expect(json.statusCode).toBe(200);
    const report = json.json<BenchmarkReport>();
    expect(report.trials.find((t) => t.runId === bench.runIds[0])!.recording).toEqual({ status: 'ready', durationMs: 42_000 });
    expect(json.body).not.toMatch(/run-recordings\/|recording\.webm/);

    const csv = await app.inject({ method: 'GET', url: `/api/benchmarks/${bench.id}/export?format=csv`, headers: admin.headers });
    expect(csv.statusCode).toBe(200);
    const [header, ...rows] = parseCsv(csv.body);
    expect(header).toEqual([...CSV_COLUMNS]);
    const col = (name: (typeof CSV_COLUMNS)[number]) => CSV_COLUMNS.indexOf(name);
    const statusOf = (i: number) => rows.find((r) => r[col('run_id')] === bench.runIds[i])![col('recording')];
    expect([0, 1, 2, 3, 4].map(statusOf)).toEqual(['ready', 'processing', 'recording', 'failed', '']);
    expect(csv.body).not.toMatch(/run-recordings\/|recording\.webm/);
  });
});
