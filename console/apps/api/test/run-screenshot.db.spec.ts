// `GET /runs/:id/screenshot` (#525): the picture of a live run's browser, also
// while the run waits for its person, and a clear 409 when the fabric refuses.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ConflictException } from '@nestjs/common';

import { FabricError, type FabricClient } from '../src/fabric/fabric.client';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { RunLiveController } from '../src/runner/run-live.controller';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;
const SESSION = '00000000-0000-4000-8000-00000000000a';

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app?.close();
});

async function owner(name: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `shot-${name}-${stamp}@example.test`, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return me.json<{ data: { id: string } }>().data.id;
}

/** A fabric that takes the picture, or refuses the action the way the real one does. */
function fabric(refuse?: FabricError) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const client = {
    request: async (method: string, path: string, opts: { body?: unknown } = {}) => {
      calls.push({ method, path, body: opts.body });
      if (refuse) throw refuse;
      return { id: 'op', state: 'succeeded', result: { artifact_id: 'art-1' } };
    },
    raw: async (method: string, path: string) => {
      calls.push({ method, path });
      return new Response(Buffer.from('jpeg-bytes'), { headers: { 'content-type': 'image/jpeg' } });
    },
  } as unknown as FabricClient;
  return { client, calls };
}

/** A reply that records what was sent. */
function reply() {
  const sent: { headers: Record<string, string>; type?: string; body?: Buffer } = { headers: {} };
  const r = {
    header: (k: string, v: string) => ((sent.headers[k] = v), r),
    type: (t: string) => ((sent.type = t), r),
    send: async (b: Buffer) => void (sent.body = b),
  };
  return { r: r as never, sent };
}

describe('GET /runs/:id/screenshot', () => {
  it('returns the picture while the run waits for its person, and asks the fabric for a plain screenshot once', async () => {
    const userId = await owner('waiting');
    const run = await prisma.run.create({ data: { userId, goal: 'Buy the item', status: 'waiting_human', sessionId: SESSION } });
    const f = fabric();
    const out = reply();
    await new RunLiveController(prisma, f.client).screenshot(userId, run.id, out.r);

    expect(out.sent.body?.toString()).toBe('jpeg-bytes');
    expect(out.sent.type).toBe('image/jpeg');
    expect(out.sent.headers['cache-control']).toBe('no-store');
    expect(f.calls).toEqual([
      { method: 'POST', path: `/v1/sessions/${SESSION}/actions`, body: { action: { type: 'screenshot' }, timeout_ms: 20_000 } },
      { method: 'GET', path: '/v1/artifacts/art-1' },
    ]);
  });

  it('answers 409 SCREENSHOT_FAILED at once when the fabric refuses (a secret is being asked for, or an older fabric)', async () => {
    const userId = await owner('refused');
    const run = await prisma.run.create({ data: { userId, goal: 'Sign in', status: 'waiting_human', sessionId: SESSION } });
    for (const code of ['handoff_pending', 'takeover_active']) {
      const f = fabric(new FabricError('api', `${code}: the session waits`, 409, code));
      const started = Date.now();
      const failed = await new RunLiveController(prisma, f.client).screenshot(userId, run.id, reply().r).catch((e: unknown) => e);
      expect(failed).toBeInstanceOf(ConflictException);
      expect((failed as ConflictException).getResponse()).toMatchObject({ code: 'SCREENSHOT_FAILED' });
      // Asked once: a picture does not wait for the person to finish.
      expect(f.calls).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(2_000);
    }
  });

  it('has no picture for a run that ended or never got a browser', async () => {
    const userId = await owner('ended');
    const ended = await prisma.run.create({ data: { userId, goal: 'Done', status: 'succeeded', sessionId: SESSION } });
    const fresh = await prisma.run.create({ data: { userId, goal: 'Queued' } });
    for (const run of [ended, fresh]) {
      const f = fabric();
      const failed = await new RunLiveController(prisma, f.client).screenshot(userId, run.id, reply().r).catch((e: unknown) => e);
      expect((failed as ConflictException).getResponse()).toMatchObject({ code: 'RUN_NOT_LIVE' });
      expect(f.calls).toHaveLength(0);
    }
  });
});
