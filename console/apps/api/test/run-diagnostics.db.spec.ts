// GET /api/runs/{id}/diagnostics (E52.6, #1021) against a real database: the owner's run only, computed from its steps, masked,
// at most 2,000 steps read. Every role holds `runs:read`, so there is no 403 case to prove.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = Date.now();

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app?.close();
});

async function login(email: string): Promise<{ token: string; userId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const user = await prisma.user.findFirstOrThrow({ where: { email }, select: { id: true } });
  return { token, userId: user.id };
}

async function runWith(userId: string, steps: { action: string; args: object; ok?: boolean; summary?: string }[]) {
  const db = prisma.forUser({ userId });
  const run = await db.run.create({ data: { userId, goal: 'Send a text message to Sam Example', status: 'succeeded', startedAt: new Date(Date.now() - 600_000) } });
  await prisma.runStep.createMany({
    data: steps.map((s, i) => ({ runId: run.id, seq: i + 1, kind: 'action', action: s.action, args: s.args, ok: s.ok ?? true, summary: s.summary ?? 'done', reasoning: 'the agent said something' })),
  });
  return run.id;
}

const get = (id: string, token?: string) => app.inject({ method: 'GET', url: `/api/runs/${id}/diagnostics`, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });

describe('GET /api/runs/{id}/diagnostics', () => {
  it('answers the owner with the findings of the run: a loop and a repeated click', async () => {
    const owner = await login(`diag-owner-${stamp}@example.test`);
    const lap = [
      { action: 'click_at', args: { x: 90, y: 100 } },
      { action: 'text', args: { max_chars: 6000 }, summary: 'read 3000 characters' },
      { action: 'click_at', args: { x: 1160, y: 540 } },
      { action: 'text', args: { max_chars: 6000 }, summary: 'read 3000 characters' },
    ];
    const id = await runWith(owner.userId, [...lap, ...lap, ...lap, ...lap]);
    const res = await get(id, owner.token);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { runId: string; stepsRead: number; truncated: boolean; findings: { code: string; severity: string }[] } }>().data;
    expect(body).toMatchObject({ runId: id, stepsRead: 16, truncated: false });
    expect(body.findings[0]).toMatchObject({ code: 'loop', severity: 'warn' });
    expect(JSON.stringify(body)).not.toContain('the agent said something');
  });

  it('is a 404 for another user, and a 401 without a token', async () => {
    const owner = await login(`diag-a-${stamp}@example.test`);
    const other = await login(`diag-b-${stamp}@example.test`);
    const id = await runWith(owner.userId, [{ action: 'navigate', args: { url: 'https://chat.example.test/' } }]);
    expect((await get(id, other.token)).statusCode).toBe(404);
    expect((await get(id)).statusCode).toBe(401);
  });

  it('reads at most 2,000 steps and says so', async () => {
    const owner = await login(`diag-long-${stamp}@example.test`);
    const id = await runWith(
      owner.userId,
      Array.from({ length: 2_001 }, (_, i) => ({ action: 'click', args: { selector: `#s${i}` } })),
    );
    const body = (await get(id, owner.token)).json<{ data: { stepsRead: number; truncated: boolean } }>().data;
    expect(body).toMatchObject({ stepsRead: 2_000, truncated: true });
  });
});
