// The db tier of the AI usage rollups (#732): idempotent windows, the watermark
// split (rollups before it, the ledger after it) and the unit sums.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { PrismaSystemService } from '../src/prisma/prisma-system.service';
import { UsageRollupService } from '../src/usage/usage-rollup.service';

let app: NestFastifyApplication;
let rollup: UsageRollupService;
let system: PrismaSystemService;
const stamp = `${Date.now()}`;

beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  rollup = app.get(UsageRollupService);
  system = app.get(PrismaSystemService);
});
afterAll(async () => {
  await app?.close();
});

async function userId(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return me.json<{ data: { id: string } }>().data.id;
}

const H = 3_600_000;

describe('the AI usage rollups (#732)', () => {
  it('rolls the ledger per hour, idempotently, and reads rollups plus the unrolled ledger with the same totals', async () => {
    const db = system.asSystem('admin-aggregate');
    const user = await userId(`rollup-${stamp}@example.test`);
    const model = `rollup-model-${stamp}`;
    // Three hours ago, two hours ago (twice, one failed with units) and in the current hour.
    const now = new Date();
    const hourStart = new Date(Math.floor(now.getTime() / H) * H);
    const at = (hoursAgo: number, min = 10) => new Date(hourStart.getTime() - hoursAgo * H + min * 60_000);
    const base = { userId: user, provider: 'openai', modelId: model, operation: 'responses', keySource: 'user', latencyMs: 100, feature: 'browser_agent' };
    await db.aiUsageEvent.createMany({
      data: [
        { ...base, createdAt: at(3), status: 'succeeded', inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100, reasoningTokens: 20 },
        { ...base, createdAt: at(2), status: 'succeeded', inputTokens: 500, outputTokens: 50, units: { images: 2 } },
        { ...base, createdAt: at(2, 40), status: 'failed', inputTokens: 300, outputTokens: 0, units: { images: 1 } },
        { ...base, createdAt: new Date(hourStart.getTime() + 60_000), status: 'succeeded', inputTokens: 7, outputTokens: 3 },
      ],
    });

    const sum = (rows: { requests: number; failed: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number }[]) =>
      rows.reduce(
        (a, r) => ({ requests: a.requests + r.requests, failed: a.failed + r.failed, input: a.input + r.inputTokens, cached: a.cached + r.cachedInputTokens, output: a.output + r.outputTokens, reasoning: a.reasoning + r.reasoningTokens }),
        { requests: 0, failed: 0, input: 0, cached: 0, output: 0, reasoning: 0 },
      );
    const expected = { requests: 4, failed: 1, input: 1807, cached: 400, output: 153, reasoning: 20 };
    const range = { from: new Date(hourStart.getTime() - 6 * H), to: new Date(hourStart.getTime() + H), userId: user, model };

    // Before any rollup everything comes from the ledger.
    expect(sum(await rollup.rows(range))).toEqual(expected);

    await rollup.roll(now);
    const first = await db.aiUsageHourly.findMany({ where: { userId: user, modelId: model }, orderBy: { hour: 'asc' } });
    await rollup.roll(now);
    const second = await db.aiUsageHourly.findMany({ where: { userId: user, modelId: model }, orderBy: { hour: 'asc' } });

    // The current hour is not rolled; the three past events make two hourly rows.
    expect(second.map((r) => [r.hour.toISOString(), r.requests, r.failed, Number(r.inputTokens), r.units])).toEqual([
      [new Date(hourStart.getTime() - 3 * H).toISOString(), 1, 0, 1000, null],
      [new Date(hourStart.getTime() - 2 * H).toISOString(), 2, 1, 800, { images: 3 }],
    ]);
    expect(second.map((r) => r.hour)).toEqual(first.map((r) => r.hour));
    expect((await rollup.watermark())?.getTime()).toBeGreaterThanOrEqual(hourStart.getTime());

    // After the rollup: the past from the rollups, the current hour from the ledger, the same totals.
    expect(sum(await rollup.rows(range))).toEqual(expected);
    const hours = (await rollup.rows(range)).map((r) => r.hour.getTime());
    expect(hours).toContain(hourStart.getTime());

    // A late ledger row in a rolled hour is picked up by the next run (the rewind).
    await db.aiUsageEvent.create({ data: { ...base, createdAt: at(1, 59), status: 'succeeded', inputTokens: 11, outputTokens: 1 } });
    await rollup.roll(now);
    expect(sum(await rollup.rows(range))).toEqual({ ...expected, requests: 5, input: 1818, output: 154 });
  });
});
