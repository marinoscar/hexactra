// E45.4 (#759) against a real database: the recorder beside a job (start once the run has a session, parts stored, paused while a secret
// is asked for, stopped when the run ends, `maxMinutes`, failures that never touch the run) and the finalize job (parts joined into one
// seekable WebM, parts deleted, a run that ended outside a job finalized from what it has).
import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';
import { RecordingCallError, type RecordingChunk } from '@marinoscar/hexactra-browser-agent/recording';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { writeRecording } from '../src/recordings/recording-format';
import { partKey, recordingKey } from '../src/recordings/recording-keys';
import { RecordingsFinalizeHandler } from '../src/recordings/recordings.jobs';
import { RecordingsService } from '../src/recordings/recordings.service';
import { RunRecorder, type RecorderCalls } from '../src/runner/host/run-recorder';
import type { RunArtifactStore } from '../src/tasks/run-delete.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;
let n = 0;

const workerMode = process.env.JOBS_WORKER_MODE;
beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app?.close();
});

function memoryStore(): RunArtifactStore & { objects: Map<string, Buffer>; failPut?: boolean } {
  const objects = new Map<string, Buffer>();
  const s = {
    objects,
    failPut: false,
    put: async (key: string, bytes: Buffer) => {
      if (s.failPut) throw new Error('down');
      objects.set(key, Buffer.from(bytes));
    },
    get: async (key: string) => (objects.has(key) ? { bytes: objects.get(key)!, contentType: 'application/octet-stream' } : null),
    delete: async (key: string) => void objects.delete(key),
  };
  return s;
}

/** A fake extension: each pull returns the next scripted chunk. */
function fakeCalls(chunks: Partial<RecordingChunk>[], last: Partial<RecordingChunk> = {}) {
  const log: string[] = [];
  const calls: RecorderCalls & { log: string[]; startError?: Error; pullError?: Error } = {
    log,
    start: async (s) => {
      log.push(`start ${s}`);
      if (calls.startError) throw calls.startError;
      return `rec-${log.filter((l) => l.startsWith('start')).length}`;
    },
    pull: async (_s, r) => {
      log.push(`pull ${r}`);
      if (calls.pullError) {
        const e = calls.pullError;
        calls.pullError = undefined;
        throw e;
      }
      return chunk(chunks.shift() ?? {});
    },
    pause: async (_s, r, p) => void log.push(`pause ${r} ${p}`),
    stop: async (_s, r) => {
      log.push(`stop ${r}`);
      return chunk({ ...last, done: true, ended: 'stopped' });
    },
  };
  return calls;
}
const chunk = (c: Partial<RecordingChunk>): RecordingChunk => ({ bytes: Buffer.alloc(0), seq: 0, frames: 0, dropped: 0, durationMs: 0, ended: null, encoderError: null, done: false, ...c });

const header = () => writeRecording(320, 240, 'vp8', []);
const frames = (from: number, count: number, step = 100) =>
  writeRecording(320, 240, 'vp8', Array.from({ length: count }, (_, i) => ({ key: i === 0, ts: from + i * step, data: Buffer.alloc(8, i) }))).subarray(header().length);

async function newRun(opts: { record?: boolean; status?: 'running' | 'succeeded' | 'paused'; session?: string | null } = {}) {
  const email = `recorder-${stamp}-${n++}@example.test`;
  const user = await prisma.user.create({ data: { email, displayName: 'Recorder' } });
  const run = await prisma.forUser({ userId: user.id }).run.create({
    data: { userId: user.id, goal: 'Record me', trigger: 'api', status: opts.status ?? 'running', recordVideo: opts.record ?? true, sessionId: opts.session === undefined ? `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` : opts.session },
  });
  return { userId: user.id, runId: run.id, sessionId: run.sessionId };
}

function deps(store: RunArtifactStore | undefined) {
  return { prisma, artifacts: store, systemSettings: app.get(SystemSettingsService, { strict: false }), log: new Logger('RecorderSpec'), clock: Date.now };
}
const everyMs = 60_000; // the spec ticks by hand

describe('the run recorder (#759)', () => {
  it('does nothing for a run that did not opt in, or without storage', async () => {
    const off = await newRun({ record: false });
    expect(await RunRecorder.start(deps(memoryStore()), fakeCalls([]), off.runId, off.userId, { everyMs })).toBeNull();
    const on = await newRun();
    expect(await RunRecorder.start(deps(undefined), fakeCalls([]), on.runId, on.userId, { everyMs })).toBeNull();
    expect(await prisma.runRecording.count({ where: { runId: { in: [off.runId, on.runId] } } })).toBe(0);
  });

  it('starts once there is a session, stores each pull as a part, and stops when the run ends', async () => {
    const r = await newRun({ session: null });
    const store = memoryStore();
    const calls = fakeCalls([{ bytes: Buffer.concat([header(), frames(0, 3)]), durationMs: 300 }, { bytes: frames(300, 2), durationMs: 500 }], { bytes: frames(500, 1), durationMs: 600 });
    const rec = (await RunRecorder.start(deps(store), calls, r.runId, r.userId, { everyMs }))!;
    await rec.tick();
    expect(calls.log).toEqual([]); // no session yet
    await prisma.run.update({ where: { id: r.runId }, data: { sessionId: '00000000-0000-4000-8000-0000000000aa' } });
    await rec.tick();
    await rec.tick();
    expect(calls.log.filter((l) => l.startsWith('start'))).toHaveLength(1);
    let row = await prisma.runRecording.findUniqueOrThrow({ where: { runId: r.runId } });
    expect(row).toMatchObject({ status: 'recording', fabricId: 'rec-1', partCount: 2, durationMs: 500 });
    expect(store.objects.has(partKey(r.userId, r.runId, 0))).toBe(true);

    await prisma.run.update({ where: { id: r.runId }, data: { status: 'succeeded' } });
    await rec.endJob();
    expect(calls.log.at(-1)).toBe('stop rec-1');
    row = await prisma.runRecording.findUniqueOrThrow({ where: { runId: r.runId } });
    expect(row).toMatchObject({ status: 'processing', partCount: 3, fabricId: null });

    // The finalize job makes one video and removes the parts.
    const handler = app.get(RecordingsFinalizeHandler, { strict: false });
    const svc = new RecordingsService(prisma, store);
    expect(await svc.finalize(row.id)).toBe('ready');
    row = await prisma.runRecording.findUniqueOrThrow({ where: { runId: r.runId } });
    expect(row).toMatchObject({ status: 'ready', objectKey: recordingKey(r.userId, r.runId), mime: 'video/webm', durationMs: 600 });
    const video = store.objects.get(recordingKey(r.userId, r.runId))!;
    expect(video.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    expect(Number(row.bytes)).toBe(video.length);
    expect([...store.objects.keys()]).toEqual([recordingKey(r.userId, r.runId)]);
    expect(handler).toBeDefined();
  });

  it('withholds nothing while a secret is asked for, keeps recording while the run waits, and holds only while the owner paused it (#882)', async () => {
    const r = await newRun();
    const calls = fakeCalls([{ bytes: Buffer.concat([header(), frames(0, 1)]) }, { bytes: frames(100, 1) }]);
    const rec = (await RunRecorder.start(deps(memoryStore()), calls, r.runId, r.userId, { everyMs }))!;
    await rec.tick();
    await prisma.question.create({ data: { ownerUserId: r.userId, askedBy: `run:${r.runId}`, runId: r.runId, input: 'secret', kind: 'other', prompt: 'The code', status: 'pending', expiresAt: new Date(Date.now() + 3600_000) } as never });
    await rec.tick();
    expect(calls.log).not.toContain('pause rec-1 true');
    expect((await prisma.runRecording.findUniqueOrThrow({ where: { runId: r.runId } })).partCount).toBe(2);
    // The job ends with the run waiting for the owner: the recording goes on.
    await prisma.run.update({ where: { id: r.runId }, data: { status: 'waiting_human' } });
    await rec.endJob();
    expect(calls.log).not.toContain('pause rec-1 true');

    // A later job of a run the owner paused holds it.
    const rec2 = (await RunRecorder.start(deps(memoryStore()), calls, r.runId, r.userId, { everyMs }))!;
    await rec2.tick();
    await prisma.run.update({ where: { id: r.runId }, data: { status: 'paused' } });
    await rec2.endJob();
    expect(calls.log.at(-1)).toBe('pause rec-1 true');
    expect((await prisma.runRecording.findUniqueOrThrow({ where: { runId: r.runId } })).status).toBe('recording');
  });

  it('stops at maxMinutes with a note, and the run goes on', async () => {
    const r = await newRun();
    const calls = fakeCalls([{ bytes: Buffer.concat([header(), frames(0, 2)]), durationMs: 61 * 60_000 }]);
    const rec = (await RunRecorder.start(deps(memoryStore()), calls, r.runId, r.userId, { everyMs }))!;
    await rec.tick();
    expect(calls.log).toContain('stop rec-1');
    expect(await prisma.runRecording.findUniqueOrThrow({ where: { runId: r.runId } })).toMatchObject({ status: 'processing', note: 'max_minutes' });
    expect((await prisma.run.findUniqueOrThrow({ where: { id: r.runId } })).status).toBe('running');
    await rec.endJob();
  });

  it('starts again when the extension lost the recording, and fails cleanly without an encoder or storage', async () => {
    const r = await newRun();
    const calls = fakeCalls([{ bytes: Buffer.concat([header(), frames(0, 1)]) }, { bytes: Buffer.concat([header(), frames(0, 1)]) }]);
    const rec = (await RunRecorder.start(deps(memoryStore()), calls, r.runId, r.userId, { everyMs }))!;
    await rec.tick();
    calls.pullError = new RecordingCallError('recording_not_found');
    await rec.tick();
    expect(await prisma.runRecording.findUniqueOrThrow({ where: { runId: r.runId } })).toMatchObject({ fabricId: null, note: 'restarted' });
    await rec.tick();
    expect(calls.log.filter((l) => l.startsWith('start'))).toHaveLength(2);
    await rec.endJob();

    const noEncoder = await newRun();
    const c2 = fakeCalls([]);
    c2.startError = new RecordingCallError('encoder_unavailable');
    const rec2 = (await RunRecorder.start(deps(memoryStore()), c2, noEncoder.runId, noEncoder.userId, { everyMs }))!;
    await rec2.tick();
    expect(await prisma.runRecording.findUniqueOrThrow({ where: { runId: noEncoder.runId } })).toMatchObject({ status: 'failed', note: 'encoder_unavailable' });
    await rec2.endJob();

    const noStorage = await newRun();
    const store = memoryStore();
    store.failPut = true;
    const rec3 = (await RunRecorder.start(deps(store), fakeCalls([{ bytes: Buffer.concat([header(), frames(0, 1)]) }]), noStorage.runId, noStorage.userId, { everyMs }))!;
    await rec3.tick();
    expect(await prisma.runRecording.findUniqueOrThrow({ where: { runId: noStorage.runId } })).toMatchObject({ status: 'failed', note: 'storage_error' });
    await rec3.endJob();
    // None of it touched the runs.
    expect((await prisma.run.findMany({ where: { id: { in: [r.runId, noEncoder.runId, noStorage.runId] } } })).map((x) => x.status)).toEqual(['running', 'running', 'running']);
  });

  it('finalizes a recording whose run ended outside a job, and fails an empty one', async () => {
    const store = memoryStore();
    const svc = new RecordingsService(prisma, store);
    const ended = await newRun({ status: 'succeeded' });
    const old = new Date(Date.now() - 10 * 60_000);
    store.objects.set(partKey(ended.userId, ended.runId, 0), Buffer.concat([header(), frames(0, 3)]));
    const a = await prisma.runRecording.create({ data: { runId: ended.runId, userId: ended.userId, status: 'recording', partCount: 1 } });
    await prisma.$executeRaw`UPDATE run_recordings SET updated_at = ${old} WHERE id = ${a.id}::uuid`;
    const empty = await newRun({ status: 'succeeded' });
    const b = await prisma.runRecording.create({ data: { runId: empty.runId, userId: empty.userId, status: 'processing', partCount: 0 } });
    const live = await newRun();
    const c = await prisma.runRecording.create({ data: { runId: live.runId, userId: live.userId, status: 'recording', partCount: 0 } });
    await prisma.$executeRaw`UPDATE run_recordings SET updated_at = ${old} WHERE id = ${c.id}::uuid`;

    const due = await svc.due(new Date(), 1000);
    expect(due).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(due).not.toContain(c.id); // its run still works
    expect(await svc.finalize(a.id)).toBe('ready');
    expect(await svc.finalize(b.id)).toBe('failed');
    expect(await prisma.runRecording.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ status: 'failed', note: 'empty' });
    expect(await svc.finalize(a.id)).toBe('gone'); // safe to repeat
  });
});
