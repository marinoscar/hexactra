// Deleting benchmarks with their runs (#873) against a real, migrated database: `DELETE /api/benchmarks/{id}?deleteRuns=true` deletes the
// runs its trials started, then the benchmark; without it the runs stay; `POST /api/benchmarks/delete` deletes several, skipping a
// live one and listing one that is not the caller's; the audit event counts the runs.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { assertMayDeleteRuns } from '../src/benchmark/benchmarks.controller';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { createGradedBenchmark } from './support/benchmark-fixtures';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;
const created: string[] = [];

async function login(name: string, role = 'org_admin'): Promise<{ id: string; headers: { authorization: string } }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `bdel-${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const headers = { authorization: `Bearer ${token}` };
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers });
  return { id: me.json<{ data: { id: string } }>().data.id, headers };
}

/** A benchmark whose 12 trials each have a finished run (and a step), or a running one. */
async function withRuns(userId: string, opts: { status?: 'completed' | 'running' } = {}) {
  const runIds: string[] = [];
  for (let i = 0; i < 12; i++) {
    const run = await prisma.run.create({ data: { userId, goal: 'Look up the record.', trigger: 'benchmark', status: 'succeeded', stopReason: 'finished' } as never });
    await prisma.runStep.create({ data: { runId: run.id, seq: 0, kind: 'note', summary: 'step' } as never }).catch(() => undefined);
    runIds.push(run.id);
  }
  let next = 0;
  const b = await createGradedBenchmark(prisma, userId, { status: opts.status, result: () => ({ runId: runIds[next++]! }) });
  created.push(b.id);
  return { ...b, runIds };
}

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  if (created.length) await prisma.benchmark.deleteMany({ where: { id: { in: created } } });
  await app?.close();
});

describe('deleting benchmarks with their runs (#873)', () => {
  it('DELETE ?deleteRuns=true deletes the runs its trials started, then the benchmark, and counts them in the audit event', async () => {
    const admin = await login('with');
    const b = await withRuns(admin.id);
    const res = await app.inject({ method: 'DELETE', url: `/api/benchmarks/${b.id}?deleteRuns=true`, headers: admin.headers });
    expect(res.statusCode).toBe(204);
    expect(await prisma.benchmark.count({ where: { id: b.id } })).toBe(0);
    expect(await prisma.benchmarkTrial.count({ where: { benchmarkId: b.id } })).toBe(0);
    expect(await prisma.run.count({ where: { id: { in: b.runIds } } })).toBe(0);
    expect(await prisma.auditEvent.findFirst({ where: { action: 'benchmarks.deleted', targetId: b.id } })).toMatchObject({ actorUserId: admin.id, meta: { deleteRuns: true, runsDeleted: 12 } });
  });

  it('without deleteRuns (or with false) the runs stay in the run history', async () => {
    const admin = await login('without');
    for (const query of ['', '?deleteRuns=false']) {
      const b = await withRuns(admin.id);
      expect((await app.inject({ method: 'DELETE', url: `/api/benchmarks/${b.id}${query}`, headers: admin.headers })).statusCode).toBe(204);
      expect(await prisma.benchmark.count({ where: { id: b.id } })).toBe(0);
      expect(await prisma.run.count({ where: { id: { in: b.runIds } } })).toBe(12);
      expect(await prisma.auditEvent.findFirst({ where: { action: 'benchmarks.deleted', targetId: b.id } })).toMatchObject({ meta: { deleteRuns: false, runsDeleted: 0 } });
      await prisma.run.deleteMany({ where: { id: { in: b.runIds } } });
    }
    expect((await app.inject({ method: 'DELETE', url: `/api/benchmarks/${created.at(-1)}?deleteRuns=maybe`, headers: admin.headers })).statusCode).toBe(400);
  });

  it('refuses a running benchmark and deletes none of its runs', async () => {
    const admin = await login('live');
    const b = await withRuns(admin.id, { status: 'running' });
    expect((await app.inject({ method: 'DELETE', url: `/api/benchmarks/${b.id}?deleteRuns=true`, headers: admin.headers })).statusCode).toBe(409);
    expect(await prisma.run.count({ where: { id: { in: b.runIds } } })).toBe(12);
    expect(await prisma.benchmark.count({ where: { id: b.id } })).toBe(1);
  });

  it('POST /delete deletes several with their runs, skips a live one, and lists one that is not the caller\'s', async () => {
    const [admin, other] = [await login('bulk'), await login('bulk-other')];
    const [a, b, live, theirs] = [await withRuns(admin.id), await withRuns(admin.id), await withRuns(admin.id, { status: 'running' }), await withRuns(other.id)];
    const res = await app.inject({ method: 'POST', url: '/api/benchmarks/delete', headers: admin.headers, payload: { ids: [a.id, b.id, live.id, theirs.id], deleteRuns: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: unknown }>().data).toEqual({ deleted: [a.id, b.id], skippedRunning: [live.id], notFound: [theirs.id], runsDeleted: 24 });
    expect(await prisma.run.count({ where: { id: { in: [...a.runIds, ...b.runIds] } } })).toBe(0);
    expect(await prisma.run.count({ where: { id: { in: [...live.runIds, ...theirs.runIds] } } })).toBe(24);
    expect(await prisma.benchmark.count({ where: { id: { in: [live.id, theirs.id] } } })).toBe(2);
  });

  it('POST /delete without deleteRuns keeps the runs; an empty or malformed list is a 400; without benchmarks:run a 403', async () => {
    const admin = await login('bulk-keep');
    const a = await withRuns(admin.id);
    const res = await app.inject({ method: 'POST', url: '/api/benchmarks/delete', headers: admin.headers, payload: { ids: [a.id] } });
    expect(res.json<{ data: unknown }>().data).toEqual({ deleted: [a.id], skippedRunning: [], notFound: [], runsDeleted: 0 });
    expect(await prisma.run.count({ where: { id: { in: a.runIds } } })).toBe(12);
    expect((await app.inject({ method: 'POST', url: '/api/benchmarks/delete', headers: admin.headers, payload: { ids: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/benchmarks/delete', headers: admin.headers, payload: { ids: ['nope'] } })).statusCode).toBe(400);
    const viewer = await login('bulk-viewer', 'contributor');
    expect((await app.inject({ method: 'POST', url: '/api/benchmarks/delete', headers: viewer.headers, payload: { ids: [a.id] } })).statusCode).toBe(403);
  });

  it('deleting the runs needs runs:delete as well', () => {
    expect(() => assertMayDeleteRuns({ permissions: ['benchmarks:run'] }, true)).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'RUNS_DELETE_FORBIDDEN' }) }));
    expect(() => assertMayDeleteRuns({ permissions: ['benchmarks:run'] }, false)).not.toThrow();
    expect(() => assertMayDeleteRuns({ permissions: ['benchmarks:run', 'runs:delete'] }, true)).not.toThrow();
  });

  it('is in the OpenAPI document: the deleteRuns query and the bulk route', async () => {
    const doc = (await app.inject({ method: 'GET', url: '/api/openapi.json' })).json<{ paths: Record<string, Record<string, { parameters?: { name: string }[] }>> }>();
    expect(doc.paths['/api/benchmarks/{id}']?.delete?.parameters?.map((p) => p.name).sort()).toEqual(['deleteRuns', 'id']);
    expect(doc.paths['/api/benchmarks/delete']?.post).toBeDefined();
  });
});
