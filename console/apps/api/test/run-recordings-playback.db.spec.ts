// E45.5 (#760) against a real database: a run's recording on the run page. Owner-only (another user gets 404), a 15-minute signed link,
// the video by that link with HTTP Range, Delete (audited), and the recording kept out of the run's export.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { RECORDING_DELETED_AUDIT_ACTION, RecordingLinkController, RunRecordingController, parseRange } from '../src/recordings/recordings.controller';
import { partKey, recordingKey } from '../src/recordings/recording-keys';
import { signToken } from '../src/tasks/signed-token';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;
const objects = new Map<string, Buffer>();
const store = {
  put: async (k: string, b: Buffer) => void objects.set(k, b),
  get: async (k: string) => (objects.has(k) ? { bytes: objects.get(k)!, contentType: 'video/webm' } : null),
  delete: async (k: string) => void objects.delete(k),
};

const workerMode = process.env.JOBS_WORKER_MODE;
beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
  prisma = app.get(PrismaService);
  // The test deployment has no storage slice: both controllers get an in-memory store.
  (app.get(RunRecordingController, { strict: false }) as unknown as { store: typeof store }).store = store;
  (app.get(RecordingLinkController, { strict: false }) as unknown as { store: typeof store }).store = store;
});
afterAll(async () => {
  await app?.close();
});

type Session = { token: string; userId: string };
async function login(name: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `play-${name}-${stamp}@example.test`, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
const req = (s: Session | null, method: 'GET' | 'POST' | 'DELETE', url: string, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...(s ? { authorization: `Bearer ${s.token}` } : {}), ...headers }, ...(method === 'POST' ? { payload: {} } : {}) });

const VIDEO = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));

async function recordedRun(owner: Session) {
  const run = await prisma.forUser({ userId: owner.userId }).run.create({ data: { userId: owner.userId, goal: 'Recorded', trigger: 'api', status: 'succeeded', recordVideo: true } });
  const key = recordingKey(owner.userId, run.id);
  objects.set(key, VIDEO);
  objects.set(partKey(owner.userId, run.id, 0), Buffer.from('left over'));
  const rec = await prisma.runRecording.create({ data: { runId: run.id, userId: owner.userId, status: 'ready', objectKey: key, bytes: VIDEO.length, durationMs: 4000, partCount: 1 } });
  return { runId: run.id, key, rec };
}

describe('run recording playback (#760)', () => {
  let owner: Session;
  let other: Session;
  beforeAll(async () => {
    owner = await login('owner');
    other = await login('other');
  });

  it('shows the recording to its owner only, with when the policy deletes it', async () => {
    const { runId, rec } = await recordedRun(owner);
    const got = await req(owner, 'GET', `/api/runs/${runId}/recording`);
    expect(got.statusCode).toBe(200);
    const body = got.json<{ data: Record<string, unknown> }>().data;
    expect(body).toMatchObject({ status: 'ready', bytes: 1000, durationMs: 4000, masked: false, mime: 'video/webm' });
    expect(body.expiresAt).toBe(new Date(rec.createdAt.getTime() + 30 * 86_400_000).toISOString());
    expect(JSON.stringify(body)).not.toContain('run-recordings/');
    expect((await req(other, 'GET', `/api/runs/${runId}/recording`)).statusCode).toBe(404);
    expect((await req(other, 'POST', `/api/runs/${runId}/recording/link`)).statusCode).toBe(404);
    expect((await req(null, 'GET', `/api/runs/${runId}/recording`)).statusCode).toBe(401);
  });

  it('plays by a signed link, with ranges, and refuses an altered or expired one', async () => {
    const { runId, rec } = await recordedRun(owner);
    const link = (await req(owner, 'POST', `/api/runs/${runId}/recording/link`)).json<{ data: { url: string } }>().data.url;
    expect(link).toMatch(/^\/api\/recordings\//);
    const whole = await req(null, 'GET', link);
    expect(whole.statusCode).toBe(200);
    expect(whole.headers['cache-control']).toBe('private, no-store');
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.rawPayload.length).toBe(1000);
    const part = await req(null, 'GET', link, { range: 'bytes=10-19' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 10-19/1000');
    expect(Array.from(part.rawPayload)).toEqual(Array.from(VIDEO.subarray(10, 20)));
    expect((await req(null, 'GET', link, { range: 'bytes=5000-' })).statusCode).toBe(416);
    expect((await req(null, 'GET', `${link}x`)).statusCode).toBe(404);
    const expired = signToken('run-recording', { r: rec.id, u: owner.userId }, 60, Date.now() - 3600_000);
    expect((await req(null, 'GET', `/api/recordings/${expired}`)).statusCode).toBe(404);
    // A link made for another purpose never plays.
    expect((await req(null, 'GET', `/api/recordings/${signToken('run-report', { r: rec.id, u: owner.userId }, 600)}`)).statusCode).toBe(404);
  });

  it('is deleted by its owner only, with its objects, and audited', async () => {
    const { runId, key } = await recordedRun(owner);
    expect((await req(other, 'DELETE', `/api/runs/${runId}/recording`)).statusCode).toBe(404);
    expect((await req(owner, 'DELETE', `/api/runs/${runId}/recording`)).statusCode).toBe(204);
    expect(objects.has(key)).toBe(false);
    expect(objects.has(partKey(owner.userId, runId, 0))).toBe(false);
    expect((await req(owner, 'GET', `/api/runs/${runId}/recording`)).statusCode).toBe(404);
    expect(await prisma.auditEvent.count({ where: { action: RECORDING_DELETED_AUDIT_ACTION, targetId: runId, actorUserId: owner.userId } })).toBe(1);
    // The run stays.
    expect(await prisma.run.count({ where: { id: runId } })).toBe(1);
  });

  it('is not part of the run export', async () => {
    const { runId } = await recordedRun(owner);
    const exported = await req(owner, 'GET', `/api/runs/${runId}/export?format=json&screenshots=embed`);
    expect(exported.statusCode).toBe(200);
    expect(exported.body).not.toMatch(/run-recordings|recording\.webm|recordVideo|\/api\/recordings\//);
  });
});

describe('parseRange', () => {
  it('reads the forms a video player sends', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=10-20', 100)).toEqual({ start: 10, end: 20 });
    expect(parseRange('bytes=90-200', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('items=0-1', 100)).toBe('invalid');
  });
});
