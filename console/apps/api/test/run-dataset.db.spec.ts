// The run dataset (E53.3, #1071) against a real database: the source, run through the platform's own JSON and CSV writers with the
// read client the export job uses, holds exactly the owner's runs the list shows for the same filter, masked, with findings and
// (on request) steps; the export routes offer it and validate its request.
import { PassThrough } from 'node:stream';
import { CSV_EXPORT_WRITER, JSON_EXPORT_WRITER, type ExportContext } from '@marinoscar/platform-api/exports';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Prisma } from '@prisma/client';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaSystemService } from '../src/prisma/prisma-system.service';
import { RUN_DATASET_EXPORT_SOURCE, datasetFilter, runDatasetRequestSchema, type RunDatasetRequest } from '../src/run-insights/run-dataset.source';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;
const T0 = Date.parse('2026-06-01T12:00:00.000Z');
const DAY = 86_400_000;
const CARD = '4111 1111 1111 1111';

async function login(name: string): Promise<{ token: string; userId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `${name}-${stamp}@example.test`, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}

type Row = Record<string, string | number | boolean | null>;
interface Dataset {
  runs: Row[];
  findings: Row[];
  steps?: Row[];
}

function ctxFor(userId: string, pageSize = 2): ExportContext {
  return { exportId: 'test', scope: 'user', subjectId: userId, requestedById: userId, db: app.get(PrismaSystemService).asSystem('export'), datamodel: Prisma.dmmf.datamodel, pageSize, now: new Date(), timeZone: 'UTC' } as ExportContext;
}

async function write(writer: typeof JSON_EXPORT_WRITER, userId: string, request: Partial<RunDatasetRequest>): Promise<{ body: Buffer; rowCounts: Record<string, number> }> {
  const req = runDatasetRequestSchema.parse(request);
  const out = new PassThrough();
  const parts: Buffer[] = [];
  out.on('data', (c: Buffer) => parts.push(c));
  const result = await writer.write(RUN_DATASET_EXPORT_SOURCE.collect(ctxFor(userId), req), out, { source: RUN_DATASET_EXPORT_SOURCE.id, exportedAt: new Date(), appSlug: 'hexactra' });
  return { body: Buffer.concat(parts), rowCounts: { ...result.rowCounts } };
}

async function dataset(userId: string, request: Partial<RunDatasetRequest> = {}): Promise<Dataset> {
  const { body } = await write(JSON_EXPORT_WRITER, userId, request);
  const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  // The platform's JSON writer: `datasets.<name>` is `{ title, columns, rows }`.
  const tables = parsed.datasets as Record<string, { rows: Row[] }>;
  return { runs: tables.runs?.rows ?? [], findings: tables.findings?.rows ?? [], ...(tables.steps ? { steps: tables.steps.rows } : {}) };
}

// No job worker: the route test queues a real `export.run` job, and with a worker on it ran this source to the upload, which fails
// with no object storage in the test environment (an unhandled error after the tests passed). The file itself is tested above the
// queue, through the platform's own writers.
const workerMode = process.env.JOBS_WORKER_MODE;
beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app?.close();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
});

describe('the run dataset source', () => {
  let alice: { token: string; userId: string };
  let bob: { token: string; userId: string };
  let taskId: string;
  let looping: string;

  beforeAll(async () => {
    alice = await login('dataset-alice');
    bob = await login('dataset-bob');
    taskId = (await prisma.task.create({ data: { userId: alice.userId, name: 'Check fares', goal: 'Check fares' } })).id;
    const runs: Prisma.RunCreateManyInput[] = [];
    for (let i = 0; i < 5; i++) {
      const createdAt = new Date(T0 + i * DAY);
      runs.push({
        userId: alice.userId,
        taskId,
        goal: `Pay with card ${CARD} run ${i}`,
        status: i === 4 ? 'failed' : 'succeeded',
        stopReason: i === 4 ? 'stalled' : 'finished',
        result: i === 4 ? null : `Paid with ${CARD}`,
        error: i === 4 ? `Card ${CARD} was declined` : null,
        stepCount: 3,
        modelCalls: 4,
        inputTokens: 1000,
        cachedInputTokens: 200,
        outputTokens: 100,
        costUsd: 0.02,
        activeMs: 30_000,
        policyRef: 'builtin:balanced',
        policySnapshot: { name: 'Balanced', ref: 'builtin:balanced' },
        currentTier: 'standard',
        createdAt,
        startedAt: new Date(createdAt.getTime() + 1_000),
        finishedAt: new Date(createdAt.getTime() + 61_000),
      });
    }
    runs.push({ userId: alice.userId, goal: 'still going', status: 'running', createdAt: new Date(T0 + 6 * DAY) });
    runs.push({ userId: alice.userId, goal: 'trial', status: 'succeeded', trigger: 'benchmark', createdAt: new Date(T0 + 2 * DAY) });
    runs.push({ userId: bob.userId, goal: `bob ${CARD}`, status: 'succeeded', createdAt: new Date(T0) });
    await prisma.run.createMany({ data: runs });
    // The failed run clicks the same selector again and again, failing each time: a loop and failures.
    looping = (await prisma.run.findFirstOrThrow({ where: { userId: alice.userId, status: 'failed' }, select: { id: true } })).id;
    await prisma.runStep.createMany({
      data: Array.from({ length: 8 }, (_, i) => ({
        runId: looping,
        seq: i + 1,
        kind: 'action',
        action: 'click',
        args: { selector: '#pay', note: `card ${CARD}` },
        ok: false,
        summary: `No element matches #pay (card ${CARD})`,
        reasoning: `I will try the card ${CARD} again`,
        phase: 'done',
        durationMs: 120,
        createdAt: new Date(T0 + 4 * DAY + i * 1_000),
      })),
    });
  });

  it('holds the owner finished runs the list shows, newest first, and none of anyone else', async () => {
    const d = await dataset(alice.userId);
    const list = (await app.inject({ method: 'GET', url: '/api/runs?state=finished&limit=200', headers: { authorization: `Bearer ${alice.token}` } })).json<{ data: { id: string }[] }>().data;
    expect(d.runs.map((r) => r.run_id)).toEqual(list.map((r) => r.id));
    expect(d.runs).toHaveLength(5);
    expect(d.runs.every((r) => r.task_id === taskId)).toBe(true);
    expect((await dataset(bob.userId)).runs).toHaveLength(1);
  });

  it('carries the numbers, names and keys of a run', async () => {
    const [newest] = (await dataset(alice.userId)).runs;
    expect(newest).toMatchObject({
      status: 'failed',
      stop_reason: 'stalled',
      trigger: 'manual',
      origin: 'web',
      task_name: 'Check fares',
      policy_id: 'builtin:balanced',
      policy_name: 'Balanced',
      tier: 'standard',
      steps: 3,
      model_calls: 4,
      input_tokens: 1000,
      cached_input_tokens: 200,
      output_tokens: 100,
      total_tokens: 1100,
      cost_usd: 0.02,
      cost_known: true,
      working_ms: 30_000,
      wall_ms: 60_000,
    });
  });

  it('masks every text: goal, result, error, step summaries, arguments and reasoning', async () => {
    const { body } = await write(JSON_EXPORT_WRITER, alice.userId, { includeSteps: true });
    const text = body.toString('utf8');
    expect(text).not.toContain('4111');
    expect(text).toContain('Pay with card');
    // Bob's goal is never in Alice's file.
    expect(text).not.toContain('bob ');
  });

  it('adds the findings of a run, computed from its steps', async () => {
    const d = await dataset(alice.userId);
    const codes = d.findings.filter((f) => f.run_id === looping).map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['loop', 'failures']));
    const loop = d.findings.find((f) => f.run_id === looping && f.code === 'loop')!;
    expect(loop).toMatchObject({ severity: 'warn', seq_from: expect.any(Number), steps_spent: expect.any(Number) });
    expect(String(loop.detail)).not.toContain('4111');
    expect(d.steps).toBeUndefined();
  });

  it('adds every step on request', async () => {
    const d = await dataset(alice.userId, { includeSteps: true });
    const steps = d.steps!.filter((s) => s.run_id === looping);
    expect(steps.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(steps[0]).toMatchObject({ kind: 'action', action: 'click', ok: false, phase: 'done', duration_ms: 120 });
    expect(JSON.parse(String(steps[0]!.args))).toMatchObject({ selector: '#pay' });
  });

  it('filters like the runs list: days (to inclusive), status, task, stop reason, benchmark only when named', async () => {
    const day = (n: number) => new Date(T0 + n * DAY).toISOString().slice(0, 10);
    expect((await dataset(alice.userId, { from: day(1), to: day(3) })).runs).toHaveLength(3);
    expect((await dataset(alice.userId, { status: 'failed' })).runs.map((r) => r.run_id)).toEqual([looping]);
    expect((await dataset(alice.userId, { status: 'all' })).runs).toHaveLength(6);
    expect((await dataset(alice.userId, { taskId: 'none', status: 'all' })).runs).toHaveLength(1);
    expect((await dataset(alice.userId, { stopReason: 'stalled' })).runs).toHaveLength(1);
    expect((await dataset(alice.userId, { trigger: 'benchmark' })).runs.map((r) => r.status)).toEqual(['succeeded']);
    expect(datasetFilter(runDatasetRequestSchema.parse({ stopReason: 'budget' }), 'UTC').stopReason).toEqual(['budget']);
  });

  it('writes the same tables as CSV', async () => {
    const { rowCounts } = await write(CSV_EXPORT_WRITER, alice.userId, { includeSteps: true });
    expect(rowCounts).toMatchObject({ runs: 5, steps: 8 });
    expect(rowCounts.findings).toBeGreaterThanOrEqual(1);
  });

  it('refuses a request it cannot answer', () => {
    expect(runDatasetRequestSchema.safeParse({ status: 'done' }).success).toBe(false);
    expect(runDatasetRequestSchema.safeParse({ from: '2026-06-03', to: '2026-06-01' }).success).toBe(false);
    expect(runDatasetRequestSchema.safeParse({ stopReason: 'tired' }).success).toBe(false);
    expect(runDatasetRequestSchema.safeParse({ extra: true }).success).toBe(false);
  });

  it('is offered by the export routes, which validate its request and queue it', async () => {
    const auth = { authorization: `Bearer ${alice.token}` };
    const sources = (await app.inject({ method: 'GET', url: '/api/exports/sources', headers: auth })).json<{ data: { items: { id: string; formats: { id: string }[] }[] } }>().data;
    const mine = sources.items.find((s) => s.id === 'run-dataset');
    expect(mine?.formats.map((f) => f.id)).toEqual(expect.arrayContaining(['json', 'csv', 'xlsx']));
    const bad = await app.inject({ method: 'POST', url: '/api/exports', headers: auth, payload: { source: 'run-dataset', format: 'json', request: { status: 'done' } } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/exports', headers: auth, payload: { source: 'run-dataset', format: 'json', request: { includeSteps: true } } });
    expect(ok.statusCode).toBe(202);
    expect(ok.json<{ data: { status: string } }>().data.status).toBe('pending');
  });
});
