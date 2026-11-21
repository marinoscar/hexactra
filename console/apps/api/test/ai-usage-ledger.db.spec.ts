// The db tier (#731): a model call's usage row reaches `ai_usage_events` with its tokens.
//
// The platform's `AiUsageRecorder` writes each row through `PLATFORM_PRISMA.forOrg(...)`
// and only logs a warning when the write throws. The console's `PrismaService` had no
// `forOrg`, so every model call's row was lost and Administration → AI Usage showed
// requests (catalogue syncs, written through the system client) with 0 tokens.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AiUsageRecorder } from '@marinoscar/platform-api/ai';

import { createApp } from '../src/main';
import { AiUsageLedgerDoctorCheck } from '../src/platform/ai/ai-usage-ledger.doctor-check';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaSystemService } from '../src/prisma/prisma-system.service';

let app: NestFastifyApplication;
const stamp = `${Date.now()}`;

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
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

describe('the AI usage ledger (#731)', () => {
  it('gives the platform an org-scoped client (PLATFORM_PRISMA.forOrg)', () => {
    expect(typeof app.get(PrismaService).forOrg).toBe('function');
  });

  it("stores a user's model call with its tokens, in the user's organization", async () => {
    const user = await userId(`usage-ledger-${stamp}@example.test`);
    const model = `ledger-model-${stamp}`;
    const recorder = app.get(AiUsageRecorder, { strict: false });
    await recorder.record({
      userId: user,
      provider: 'openai',
      modelId: model,
      operation: 'responses',
      keySource: 'user',
      usage: { inputTokens: 1200, outputTokens: 300, reasoningTokens: 40, cachedInputTokens: 800 },
      latencyMs: 512,
      status: 'succeeded',
      feature: 'browser_agent',
    });

    const row = await app
      .get(PrismaSystemService)
      .asSystem('admin-aggregate')
      .aiUsageEvent.findFirst({ where: { userId: user, modelId: model } });
    expect(row).toMatchObject({
      operation: 'responses',
      inputTokens: 1200,
      outputTokens: 300,
      reasoningTokens: 40,
      cachedInputTokens: 800,
      status: 'succeeded',
      feature: 'browser_agent',
    });
    expect(row?.orgId).toEqual(expect.any(String));
  });
});

describe('the ai.usage_ledger Doctor check (#731)', () => {
  it('is registered and answers from the database', async () => {
    const outcome = await app.get(AiUsageLedgerDoctorCheck, { strict: false }).run();
    expect(['pass', 'warn', 'skip', 'fail']).toContain(outcome.status);
    expect(outcome.data).toMatchObject({ windowDays: 7, responseRows: expect.any(Number), runInputTokens: expect.any(Number) });
  });
});
