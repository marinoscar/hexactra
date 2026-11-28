// A screenshot step that has no stored picture tells the agent what to do (E54.4, #1085): use save_screenshot, and which steps of this job
// do have one. A real run once tried steps 8, 11 and 59 in turn, never called save_screenshot, and asked the owner for a sign-in instead.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { loadRunArtifact } from '../src/runner/host/tools/connections/artifacts';

let app: NestFastifyApplication;
let prisma: PrismaService;

beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app?.close();
});

async function run(): Promise<{ id: string; userId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `artifact-${Date.now()}-${Math.random()}@example.test`, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  const userId = me.json<{ data: { id: string } }>().data.id;
  const r = await prisma.run.create({ data: { userId, goal: 'g', status: 'running' } });
  return { id: r.id, userId };
}

const ctxOf = (r: { id: string; userId: string }) =>
  ({ run: { id: r.id, userId: r.userId, orgId: null }, ext: { d: { prisma, artifacts: { get: async () => ({ bytes: Buffer.from('jpg'), contentType: 'image/jpeg' }) } } } }) as never;

describe('attaching a step that has no stored screenshot', () => {
  it('names save_screenshot and says no step has a picture yet', async () => {
    const r = await run();
    await prisma.runStep.create({ data: { runId: r.id, seq: 8, kind: 'action', action: 'look', summary: 'looked' } });
    const got = await loadRunArtifact(ctxOf(r), { run: 'this', source: 'screenshot', step: 8 } as never);
    expect(got).toEqual({ ok: false, text: 'Step 8 has no stored screenshot. Use save_screenshot to store the page as it is now: it returns the step to attach. No step of this job has a stored screenshot yet.' });
  });

  it('lists the steps of this job that do have one, oldest first, and still attaches one of them', async () => {
    const r = await run();
    for (const seq of [12, 4]) await prisma.runStep.create({ data: { runId: r.id, seq, kind: 'action', action: 'save_screenshot', summary: 'saved', screenshotKey: `runs/${r.userId}/${r.id}/${seq}-saved.jpg`, screenshotMasked: 0 } });
    const missing = await loadRunArtifact(ctxOf(r), { run: 'this', source: 'screenshot', step: 11 } as never);
    expect(missing).toMatchObject({ ok: false, text: expect.stringContaining('Steps of this job with a stored screenshot: 4, 12.') });
    expect(await loadRunArtifact(ctxOf(r), { run: 'this', source: 'screenshot', step: 12 } as never)).toMatchObject({ ok: true, name: 'screenshot-step-12.jpg' });
  });
});
