// E45.6 (#761) against a real database: the nightly recordings retention job enforces `recordings.keepDays` (default 30; null keeps them
// indefinitely), never touches a recording being made, applies a shorter period to recordings already kept, audits its totals; the Doctor
// check reads it; deleting a run removes its video's objects.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { partKey, recordingKey } from '../src/recordings/recording-keys';
import { RECORDINGS_RETENTION_AUDIT_ACTION, RecordingsRetentionDoctorCheck, RecordingsRetentionHandler } from '../src/recordings/recording-retention.jobs';
import { RunDeleteService } from '../src/tasks/run-delete.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
let handler: RecordingsRetentionHandler;
const stamp = `${Date.now()}`;
const DAY = 86_400_000;
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
  handler = app.get(RecordingsRetentionHandler, { strict: false });
  (handler as unknown as { store: typeof store }).store = store;
  (app.get(RunDeleteService, { strict: false }) as unknown as { store: typeof store }).store = store;
});
afterAll(async () => {
  await app?.close();
});

type Session = { token: string; userId: string };
async function login(name: string, role: 'contributor' | 'admin' = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `rr-${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
const setRecordings = (admin: Session, patch: Record<string, number | null>) =>
  app.inject({ method: 'PATCH', url: '/api/system-settings', headers: { authorization: `Bearer ${admin.token}` }, payload: { recordings: patch } });

async function recording(owner: Session, ageDays: number, status: 'ready' | 'failed' | 'recording' | 'processing' = 'ready') {
  const run = await prisma.forUser({ userId: owner.userId }).run.create({ data: { userId: owner.userId, goal: `aged ${ageDays}`, trigger: 'api', status: 'succeeded', recordVideo: true } });
  const key = recordingKey(owner.userId, run.id);
  objects.set(key, Buffer.from('video'));
  if (status !== 'ready') objects.set(partKey(owner.userId, run.id, 0), Buffer.from('part'));
  const rec = await prisma.runRecording.create({
    data: { runId: run.id, userId: owner.userId, status, objectKey: status === 'ready' ? key : null, partCount: status === 'ready' ? 0 : 1, bytes: 5, createdAt: new Date(Date.now() - ageDays * DAY) },
  });
  return { runId: run.id, id: rec.id, key };
}
const exists = async (id: string) => (await prisma.runRecording.count({ where: { id } })) === 1;

describe('recordings retention (#761)', () => {
  let admin: Session;
  let owner: Session;
  beforeAll(async () => {
    admin = await login('admin', 'admin');
    owner = await login('owner');
  });
  afterEach(async () => {
    await setRecordings(admin, { keepDays: 30, maxMinutes: 60 });
  });

  it('with 30 days, deletes a 31-day-old recording with its objects and keeps a 29-day-old one; never a live one', async () => {
    const old = await recording(owner, 31);
    const oldFailed = await recording(owner, 40, 'failed');
    const young = await recording(owner, 29);
    const live = await recording(owner, 45, 'recording');
    const making = await recording(owner, 45, 'processing');
    const totals = await handler.purge(`job-a-${stamp}`);
    expect(totals.keepDays).toBe(30);
    expect(totals.deleted).toBeGreaterThanOrEqual(2);
    expect(await exists(old.id)).toBe(false);
    expect(await exists(oldFailed.id)).toBe(false);
    expect(objects.has(old.key)).toBe(false);
    expect(objects.has(partKey(owner.userId, oldFailed.runId, 0))).toBe(false);
    expect(await exists(young.id)).toBe(true);
    expect(objects.has(young.key)).toBe(true);
    expect(await exists(live.id)).toBe(true);
    expect(await exists(making.id)).toBe(true);
    // The runs stay.
    expect(await prisma.run.count({ where: { id: { in: [old.runId, oldFailed.runId] } } })).toBe(2);
    const audit = await prisma.auditEvent.findFirst({ where: { action: RECORDINGS_RETENTION_AUDIT_ACTION, targetId: `job-a-${stamp}` } });
    expect(audit?.meta).toMatchObject({ keepDays: 30, deleted: totals.deleted });
  });

  it('keeps everything when recordings are kept indefinitely', async () => {
    expect((await setRecordings(admin, { keepDays: null })).statusCode).toBe(200);
    const ancient = await recording(owner, 900);
    const totals = await handler.purge(`job-b-${stamp}`);
    expect(totals).toMatchObject({ keepDays: null, deleted: 0 });
    expect(await exists(ancient.id)).toBe(true);
  });

  it('applies a shorter period to recordings already kept', async () => {
    const tenDays = await recording(owner, 10);
    await handler.purge(`job-c-${stamp}`);
    expect(await exists(tenDays.id)).toBe(true);
    expect((await setRecordings(admin, { keepDays: 7 })).statusCode).toBe(200);
    await handler.purge(`job-d-${stamp}`);
    expect(await exists(tenDays.id)).toBe(false);
  });

  it('reports in the Doctor', async () => {
    const check = app.get(RecordingsRetentionDoctorCheck, { strict: false });
    expect(['skip', 'warn', 'pass']).toContain((await check.run()).status);
  });

  it('removes a recording with its run', async () => {
    const r = await recording(owner, 1);
    const deleted = await app.get(RunDeleteService, { strict: false }).deleteByIds(owner.userId, [r.runId]);
    expect(deleted.deleted).toBe(1);
    expect(await exists(r.id)).toBe(false);
    expect(objects.has(r.key)).toBe(false);
  });
});
