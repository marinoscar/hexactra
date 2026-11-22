// Exporting a benchmark (E44.6, #744) against a real, migrated database: `GET /api/benchmarks/{id}/export` in the three formats with
// their headers and names, the masking of the runs' goals and results and the checks' notes in every format, a running benchmark
// exported as in progress, the baseline, the audit event and the rate limit. The benchmarks are written straight into the database
// (test/support/benchmark-fixtures.ts).
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { CSV_COLUMNS } from '../src/benchmark/benchmark-report';
import { BENCHMARK_REPORT_SECTIONS } from '../src/benchmark/benchmark-report.pdf';
import { benchmarkReportSchema, type BenchmarkReport } from '../src/benchmark/benchmark-report.schemas';
import { SUITE } from '../src/benchmark/suite/registry';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { parseCsv } from './helpers/csv-parse';
import { readPdf } from './helpers/pdf-read';
import { createGradedBenchmark } from './support/benchmark-fixtures';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;
const created: string[] = [];

const TOKEN = `pat_${'a1B2'.repeat(10)}`;
const CARD = '4111 1111 1111 1111';
const EMAIL = 'person.a@example.test';
const SITE_TOKEN = 'Zk3vQ9xT2mLp8sWc4nRb7yHd1fGj6aKe0uIo5tEq_-w';
const SENSITIVE = [TOKEN, CARD, EMAIL, SITE_TOKEN];

async function login(name: string, role = 'org_admin'): Promise<{ id: string; headers: { authorization: string } }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `export-${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const headers = { authorization: `Bearer ${token}` };
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers });
  return { id: me.json<{ data: { id: string } }>().data.id, headers };
}
const exportOf = (headers: Record<string, string>, id: string, query = '') => app.inject({ method: 'GET', url: `/api/benchmarks/${id}/export${query}`, headers });

/** A finished benchmark whose trials have runs: their goals hold the trial's site token, one result and one check note the seeded values. */
async function seeded(userId: string, opts: { status?: 'completed' | 'running' } = {}) {
  const runIds: string[] = [];
  for (let i = 0; i < 12; i++) {
    const run = await prisma.run.create({
      data: {
        userId,
        goal: `Open https://console.example.test/benchmark/t/${SITE_TOKEN}/ and look up the record of ${EMAIL}.`,
        result: i === 0 ? `Done. Paid with ${CARD}; token ${TOKEN}; mailed ${EMAIL}.` : '=Found it',
        trigger: 'benchmark',
        status: 'succeeded',
        stopReason: 'finished',
      } as never,
    });
    runIds.push(run.id);
  }
  let next = 0;
  const b = await createGradedBenchmark(prisma, userId, {
    status: opts.status,
    result: (c) => ({
      runId: runIds[next++]!,
      ...(c.policyRef === 'builtin:balanced' && c.challengeId === 'form-multistep' && c.trialIndex === 0 ? { verdict: 'fail' as const, checks: [{ name: 'total', pass: false, detail: `Sent to ${EMAIL}` }] } : {}),
    }),
  });
  created.push(b.id);
  return { ...b, runIds };
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

describe('GET /api/benchmarks/{id}/export', () => {
  it('downloads the JSON report, the CSV and the PDF with the right headers and names, masked in every format', async () => {
    const admin = await login('formats');
    const b = await seeded(admin.id);
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const name = (ext: string) => `attachment; filename="hexactra-benchmark-${b.id.slice(0, 8)}-${day}.${ext}"`;

    const json = await exportOf(admin.headers, b.id);
    expect([json.statusCode, json.headers['content-type'], json.headers['cache-control'], json.headers['content-disposition']]).toEqual([200, 'application/json; charset=utf-8', 'no-store', name('json')]);
    const report = json.json<BenchmarkReport>();
    expect(benchmarkReportSchema.safeParse(report).success).toBe(true);
    expect(report).toMatchObject({ type: 'hexactra.benchmark-report', formatVersion: 1, partial: false, benchmark: { id: b.id, suiteKey: SUITE.key, suiteVersion: SUITE.version, appVersion: '0.0.0-test' } });
    expect(report.trials).toHaveLength(12);
    expect(report.masking.hits).toMatchObject({ card: 1, token: 1 });
    const first = report.trials.find((t) => t.runId === b.runIds[0])!;
    expect(first.goal).toContain('/benchmark/t/[trial token]/');
    expect(first.result).toContain('[redacted token]');
    // Tokens and cost per trial, per policy and for the whole benchmark; the models used.
    expect(first).toMatchObject({ inputTokens: 12_000, outputTokens: 600, cachedInputTokens: 4_000, costUsd: 0.01, costKnown: true, model: 'fixture:builtin:economy' });
    expect(report.scorecard.policies.map((p) => [p.ref, p.metrics.tokens.input, p.metrics.tokens.output, p.metrics.tokens.cached, p.metrics.cost.totalUsd])).toEqual([
      ['builtin:economy', 72_000, 3_600, 24_000, 0.06],
      ['builtin:balanced', 72_000, 3_600, 24_000, 0.06],
    ]);
    expect(report.scorecard.totals).toMatchObject({ inputTokens: 144_000, outputTokens: 7_200, cachedInputTokens: 48_000, costUsd: 0.12 });

    const csv = await exportOf(admin.headers, b.id, '?format=csv');
    expect([csv.statusCode, csv.headers['content-type'], csv.headers['cache-control'], csv.headers['content-disposition']]).toEqual([200, 'text/csv; charset=utf-8', 'no-store', name('csv')]);
    const [header, ...rows] = parseCsv(csv.body);
    expect(header).toEqual([...CSV_COLUMNS]);
    expect(rows).toHaveLength(12);
    const inputs = rows.reduce((s, r) => s + Number(r[CSV_COLUMNS.indexOf('input_tokens')]), 0);
    expect(inputs).toBe(144_000);

    const pdf = await exportOf(admin.headers, b.id, '?format=pdf&paper=letter');
    expect([pdf.statusCode, pdf.headers['content-type'], pdf.headers['cache-control'], pdf.headers['content-disposition']]).toEqual([200, 'application/pdf', 'no-store', name('pdf')]);
    const read = readPdf(pdf.rawPayload);
    const text = read.text.join('\n').replace(/\s+/g, ' ');
    expect(text).toContain(BENCHMARK_REPORT_SECTIONS.ranking);
    expect(text).toContain(BENCHMARK_REPORT_SECTIONS.method);
    expect(text).toContain('151,200 (144,000 input, 7,200 output, 48,000 cached input)');
    expect(read.sizes[0]).toEqual([792, 612]);

    for (const body of [json.body, csv.body, text]) for (const s of SENSITIVE) expect(body).not.toContain(s);
    // The JSON file's run text was there to mask: the goal is in it, its email masked.
    expect(json.body).toContain('look up the record of');
  });

  it('exports a running benchmark as in progress in every format', async () => {
    const admin = await login('live');
    const b = await seeded(admin.id, { status: 'running' });
    expect((await exportOf(admin.headers, b.id)).json<BenchmarkReport>()).toMatchObject({ partial: true, scorecard: { live: true } });
    const [, ...rows] = parseCsv((await exportOf(admin.headers, b.id, '?format=csv')).body);
    expect(rows.every((r) => r[CSV_COLUMNS.indexOf('benchmark_status')] === 'in progress')).toBe(true);
    const text = readPdf((await exportOf(admin.headers, b.id, '?format=pdf')).rawPayload).text.join(' ');
    expect(text).toContain('Benchmark in progress');
  });

  it('adds the comparison with a baseline of the same suite version, and refuses another (409)', async () => {
    const admin = await login('baseline');
    const base = await createGradedBenchmark(prisma, admin.id, { trials: 1, name: 'Last week' });
    const cur = await createGradedBenchmark(prisma, admin.id, { trials: 1, result: (c) => (c.policyRef === 'builtin:economy' ? { verdict: 'fail' } : undefined) });
    const other = await createGradedBenchmark(prisma, admin.id, { trials: 1, suiteVersion: SUITE.version + 1 });
    created.push(base.id, cur.id, other.id);
    const report = (await exportOf(admin.headers, cur.id, `?baseline=${base.id}`)).json<BenchmarkReport>();
    expect(report.baseline).toMatchObject({ baseline: { id: base.id, name: 'Last week' }, current: { id: cur.id } });
    expect(report.baseline!.flipped.length).toBeGreaterThan(0);
    const text = readPdf((await exportOf(admin.headers, cur.id, `?format=pdf&baseline=${base.id}`)).rawPayload).text.join(' ');
    expect(text).toContain(BENCHMARK_REPORT_SECTIONS.baseline);
    const refused = await exportOf(admin.headers, other.id, `?format=csv&baseline=${base.id}`);
    expect([refused.statusCode, refused.json<{ code: string }>().code]).toEqual([409, 'BENCHMARK_SUITE_MISMATCH']);
  });

  it("is another administrator's benchmark: 404; without benchmarks:read: 403; a bad format: 400", async () => {
    const [owner, other] = [await login('owner'), await login('other')];
    const b = await createGradedBenchmark(prisma, owner.id, { trials: 1 });
    created.push(b.id);
    expect((await exportOf(other.headers, b.id)).statusCode).toBe(404);
    expect((await exportOf((await login('viewer', 'contributor')).headers, b.id)).statusCode).toBe(403);
    expect((await exportOf(owner.headers, b.id, '?format=xlsx')).statusCode).toBe(400);
  });

  it('writes the audit event benchmarks.exported with the format, never run text', async () => {
    const admin = await login('audit');
    const b = await seeded(admin.id);
    await exportOf(admin.headers, b.id, '?format=csv');
    await exportOf(admin.headers, b.id, '?format=pdf');
    const events = await prisma.auditEvent.findMany({ where: { actorUserId: admin.id, action: 'benchmarks.exported' }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => [e.targetType, e.targetId, (e.meta as { format?: string }).format])).toEqual([
      ['benchmark', b.id, 'csv'],
      ['benchmark', b.id, 'pdf'],
    ]);
    expect(events[1]!.meta).toMatchObject({ benchmarkId: b.id, format: 'pdf', paper: 'a4', partial: false, trials: 12 });
    const all = JSON.stringify(events);
    expect(all).not.toContain('look up the record');
    expect(all).not.toContain('Found it');
  });

  it('allows 10 exports a minute per user (every format together), then answers 429 EXPORT_RATE_LIMITED', async () => {
    const admin = await login('rate');
    const b = await createGradedBenchmark(prisma, admin.id, { trials: 1 });
    created.push(b.id);
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await exportOf(admin.headers, b.id, `?format=${['json', 'csv'][i % 2]}`)).statusCode);
    expect(codes.every((c) => c === 200)).toBe(true);
    const last = await exportOf(admin.headers, b.id, '?format=pdf');
    expect([last.statusCode, last.json<{ code?: string }>().code]).toEqual([429, 'EXPORT_RATE_LIMITED']);
    // Another user is not limited by it.
    const second = await login('rate-other');
    const theirs = await createGradedBenchmark(prisma, second.id, { trials: 1 });
    created.push(theirs.id);
    expect((await exportOf(second.headers, theirs.id, '?format=csv')).statusCode).toBe(200);
  });

  it('is in the OpenAPI document with its query and the three media types', async () => {
    const doc = (await app.inject({ method: 'GET', url: '/api/openapi.json' })).json<{ paths: Record<string, { get?: { parameters?: { name: string }[]; responses?: Record<string, { content?: Record<string, unknown> }> } }> }>();
    const op = doc.paths['/api/benchmarks/{id}/export']?.get;
    expect(op?.parameters?.map((p) => p.name).sort()).toEqual(['baseline', 'format', 'id', 'paper']);
    expect(Object.keys(op?.responses?.['200']?.content ?? {}).sort()).toEqual(['application/json', 'application/pdf', 'text/csv']);
  });
});
