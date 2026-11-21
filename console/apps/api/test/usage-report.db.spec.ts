// The db tier of the usage and cost routes (#733): a user sees only their own
// usage, an AI administrator everyone's, cost uses the admin's prices, and the
// CSV has the same numbers.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { PrismaSystemService } from '../src/prisma/prisma-system.service';

let app: NestFastifyApplication;
const stamp = `${Date.now()}`;

beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
});

type Session = { token: string; userId: string };
async function login(email: string, role: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
const as = (s: Session) => ({ authorization: `Bearer ${s.token}` });

interface Report {
  scope: string;
  totals: { requests: number; inputTokens: number; outputTokens: number; costUsd: number; costKnown: boolean };
  byModel: { model: string; costUsd: number | null }[];
  series: { key: string; label: string }[];
  unpricedModels: string[];
  runs: { count: number };
}

describe('the usage and cost routes (#733)', () => {
  let alice: Session;
  let bob: Session;
  let admin: Session;
  const model = `report-model-${stamp}`;
  const other = `report-other-${stamp}`;

  beforeAll(async () => {
    alice = await login(`usage-alice-${stamp}@example.test`, 'contributor');
    bob = await login(`usage-bob-${stamp}@example.test`, 'contributor');
    admin = await login(`usage-admin-${stamp}@example.test`, 'admin');
    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/system-settings',
      headers: as(admin),
      payload: { agentPricing: { models: { [`openai:${model}`]: { inputPerMTok: 2, outputPerMTok: 10 } } } },
    });
    expect(patched.statusCode).toBe(200);
    const db = app.get(PrismaSystemService).asSystem('admin-aggregate');
    const base = { provider: 'openai', operation: 'responses', keySource: 'user', latencyMs: 50, status: 'succeeded', feature: 'browser_agent', createdAt: new Date(Date.now() - 60_000) };
    await db.aiUsageEvent.createMany({
      data: [
        { ...base, userId: alice.userId, modelId: model, inputTokens: 1_000_000, outputTokens: 100_000 },
        { ...base, userId: alice.userId, modelId: other, inputTokens: 10, outputTokens: 1 },
        { ...base, userId: bob.userId, modelId: model, inputTokens: 500_000, outputTokens: 0 },
        // A catalogue sync is left out of reports.
        { ...base, userId: null, modelId: model, operation: 'catalog', keySource: 'admin_discovery', feature: null },
      ],
    });
  });

  it("answers the caller's own usage, priced, with unpriced models flagged", async () => {
    const res = await app.inject({ method: 'GET', url: `/api/usage/report?range=7d&model=${model}`, headers: as(alice) });
    expect(res.statusCode).toBe(200);
    const r = res.json<{ data: Report }>().data;
    expect(r.scope).toBe('me');
    expect(r.totals).toMatchObject({ requests: 1, inputTokens: 1_000_000, outputTokens: 100_000, costKnown: true });
    expect(r.totals.costUsd).toBeCloseTo(3, 6); // 1M * $2 + 0.1M * $10

    const all = (await app.inject({ method: 'GET', url: '/api/usage/report?range=30d', headers: as(alice) })).json<{ data: Report }>().data;
    expect(all.unpricedModels).toContain(`openai:${other}`);
    expect(all.totals.costKnown).toBe(false);
    expect(all.byModel.find((m) => m.model === other)?.costUsd).toBeNull();
  });

  it('refuses everyone else’s usage to a user, and a userId filter without scope=all', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/usage/report?scope=all', headers: as(alice) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/usage/report?userId=${bob.userId}`, headers: as(alice) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/usage/report?breakdown=user', headers: as(alice) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/usage/report' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/usage/report?range=2y', headers: as(alice) })).statusCode).toBe(400);
  });

  it('gives an AI administrator every user, split by user with their e-mail, never the catalogue syncs', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/usage/report?scope=all&range=7d&model=${model}&breakdown=user`, headers: as(admin) });
    expect(res.statusCode).toBe(200);
    const r = res.json<{ data: Report }>().data;
    expect(r.totals.requests).toBe(2);
    expect(r.totals.costUsd).toBeCloseTo(4, 6);
    expect(r.series.map((s) => s.label).sort()).toEqual([`usage-alice-${stamp}@example.test`, `usage-bob-${stamp}@example.test`]);
  });

  it('exports the same numbers as CSV, as an attachment', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/usage/export.csv?range=7d&model=${model}`, headers: as(alice) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment; filename="ai-usage-me-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = res.body.split('\r\n').filter(Boolean);
    expect(lines[0]).toBe('period,provider,model,feature,requests,failed,input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,total_tokens,cost_usd,cost_known');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(new RegExp(`^\\d{4}-\\d{2}-\\d{2},openai,${model},browser_agent,1,0,1000000,0,100000,0,1100000,3,true$`));

    const admins = await app.inject({ method: 'GET', url: `/api/usage/export.csv?scope=all&range=7d&model=${model}`, headers: as(admin) });
    expect(admins.body.split('\r\n')[0]).toContain(',user,');
    expect(admins.body).toContain(`usage-bob-${stamp}@example.test`);
  });

  it('buckets a year by month', async () => {
    const r = (await app.inject({ method: 'GET', url: '/api/usage/report?range=1y&tz=America/Chicago', headers: as(alice) })).json<{ data: { granularity: string; buckets: string[]; timeZone: string } }>().data;
    expect(r.granularity).toBe('month');
    expect(r.buckets).toHaveLength(12);
    expect(r.timeZone).toBe('America/Chicago');
  });
});
