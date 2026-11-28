// How long a run waited for the model, and which models served it (E54.0, #1081), saved with each checkpoint: `model_ms` adds up, `models`
// holds each model once, and a job that lost the run writes neither.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { RunLease } from '../src/runner/lease';
import { saveMemoryRaw } from '../src/runner/host/finish-run';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;

const usage = (modelMs: number, models: string[]) => ({
  modelCalls: models.length,
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  costUsd: 0.001,
  costKnown: true,
  byModel: Object.fromEntries(models.map((m) => [m, { calls: 1, costUsd: 0.001, ms: modelMs / models.length }])),
  modelMs,
});

beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app?.close();
});

async function newRun(): Promise<{ userId: string; runId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `model-time-${stamp}-${Math.random()}@example.test`, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  const userId = me.json<{ data: { id: string } }>().data.id;
  const run = await prisma.run.create({ data: { userId, goal: 'g', status: 'running' } });
  return { userId, runId: run.id };
}

const deps = () => ({ prisma, log: { warn: jest.fn(), log: jest.fn() } }) as never;

describe('saving the model time and the models', () => {
  it('adds the model time of each chunk and keeps each model once, sorted', async () => {
    const { userId, runId } = await newRun();
    const lease = await RunLease.claim(prisma, userId, runId);
    expect(await saveMemoryRaw(deps(), userId, runId, { log: [] } as never, usage(1_500, ['openai:gpt-fast', 'unknown']) as never, lease)).toBe(true);
    expect(await saveMemoryRaw(deps(), userId, runId, { log: [] } as never, usage(2_250, ['anthropic:claude-x', 'openai:gpt-fast']) as never, lease)).toBe(true);
    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId }, select: { modelMs: true, models: true, modelCalls: true } });
    expect(run).toEqual({ modelMs: 3_750, models: ['anthropic:claude-x', 'openai:gpt-fast'], modelCalls: 4 });
  });

  it('writes nothing for a job that lost the run', async () => {
    const { userId, runId } = await newRun();
    const first = await RunLease.claim(prisma, userId, runId);
    await RunLease.claim(prisma, userId, runId); // another job took it over
    expect(await saveMemoryRaw(deps(), userId, runId, { log: [] } as never, usage(9_000, ['openai:gpt-fast']) as never, first)).toBe(false);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: runId }, select: { modelMs: true, models: true } })).toEqual({ modelMs: 0, models: [] });
  });

  it('accepts a usage from before the field existed (no modelMs)', async () => {
    const { userId, runId } = await newRun();
    const lease = await RunLease.claim(prisma, userId, runId);
    const { modelMs: _m, ...old } = usage(0, []);
    expect(await saveMemoryRaw(deps(), userId, runId, { log: [] } as never, old as never, lease)).toBe(true);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: runId }, select: { modelMs: true } })).modelMs).toBe(0);
  });
});
