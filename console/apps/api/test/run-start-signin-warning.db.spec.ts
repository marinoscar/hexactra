// A run start on a profile that needs a Google sign-in (E48.5, #931), against a real database: the run starts as always
// and the response carries one `PROFILE_NOT_SIGNED_IN` warning; a signed-in, unknown or unreachable fleet adds nothing,
// so the response is exactly the run as before.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { JobsService } from '@marinoscar/platform-api/jobs';

import { FabricClient, type FabricHost } from '../src/fabric/fabric.client';
import { createApp } from '../src/main';
import { runResponseSchema } from '../src/openapi/console.responses';
import { PrismaService } from '../src/prisma/prisma.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
let hosts: jest.SpiedFunction<FabricClient['hosts']>;
let enqueue: jest.SpiedFunction<JobsService['enqueue']>;
const stamp = `${Date.now()}`;
const HOME = randomUUID();
const OTHER = randomUUID();
const EMAIL = `signin-owner-${stamp}@example.test`;

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  return new URL(String(res.headers.location)).searchParams.get('token')!;
}
const as = (token: string) => ({ authorization: `Bearer ${token}` });

function fabricHost(id: string, name: string, status: Record<string, 'signed_in' | 'signed_out' | 'expired' | 'unknown'>, over: Partial<FabricHost> = {}): FabricHost {
  const names = Object.keys(status);
  return {
    id,
    name,
    version: '1.0.0',
    online: true,
    browser_connected: true,
    on_demand: true,
    profiles: names,
    running_profiles: [],
    last_seen: new Date().toISOString(),
    profile_status: names.map((n) => ({ name: n, running: false, signin: status[n], accounts: status[n] === 'unknown' ? [] : [{ provider: 'google', email: EMAIL, state: status[n] }], checked_at: new Date().toISOString() })),
    ...over,
  } as FabricHost;
}

let token: string;
beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  hosts = jest.spyOn(app.get(FabricClient), 'hosts');
  enqueue = jest.spyOn(app.get(JobsService), 'enqueue').mockResolvedValue({ id: 'job' } as never);
  token = await login(`run-signin-${stamp}@example.test`);
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  hosts.mockReset();
  enqueue.mockClear();
});

async function start(payload: Record<string, unknown>) {
  const res = await app.inject({ method: 'POST', url: '/api/runs', headers: as(token), payload: { goal: 'Read my newest email', ...payload } });
  expect(res.statusCode).toBe(201);
  return res.json<{ data: Record<string, unknown> & { id: string; warnings?: { code: string; message: string; hostId: string; profile: string }[] } }>().data;
}

describe('POST /runs on a profile that needs a Google sign-in', () => {
  it('starts the run and returns the warning (signed out, on the chosen machine)', async () => {
    hosts.mockResolvedValue([fabricHost(HOME, 'home-pc', { default: 'signed_out', work: 'signed_in' })]);
    const run = await start({ hostId: HOME });
    expect(run.status).toBe('queued');
    expect(run.warnings).toEqual([{ code: 'PROFILE_NOT_SIGNED_IN', message: expect.stringContaining('This profile is not signed in to Google'), hostId: HOME, profile: 'default' }]);
    expect(run.warnings![0]!.message).toContain('home-pc');
    expect(JSON.stringify(run)).not.toContain(EMAIL);
    // The run is unchanged: the same row, queued for the runner as always.
    const row = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(row).toMatchObject({ status: 'queued', profile: 'default', hostId: HOME });
    expect(enqueue).toHaveBeenCalledTimes(1);
    // The response is the run's shape plus `warnings`: the same keys as a start with nothing to say.
    hosts.mockResolvedValue([fabricHost(HOME, 'home-pc', { default: 'signed_in' })]);
    const plain = await start({ hostId: HOME });
    const { warnings: _w, ...rest } = run;
    expect(Object.keys(rest).sort()).toEqual(Object.keys(plain).sort());
    expect(runResponseSchema.safeParse(rest).success).toBe(true);
  });

  it('an expired session warns too; with any machine, only when every available machine with the profile needs it', async () => {
    hosts.mockResolvedValue([fabricHost(HOME, 'home-pc', { shop: 'expired' }), fabricHost(OTHER, 'office', { default: 'signed_in' })]);
    const run = await start({ profile: 'shop' });
    expect(run.warnings).toEqual([expect.objectContaining({ code: 'PROFILE_NOT_SIGNED_IN', hostId: HOME, profile: 'shop' })]);
    expect(run.warnings![0]!.message).toContain('expired');

    hosts.mockResolvedValue([fabricHost(HOME, 'home-pc', { shop: 'signed_out' }), fabricHost(OTHER, 'office', { shop: 'signed_in' })]);
    expect((await start({ profile: 'shop' })).warnings).toBeUndefined();
  });

  it('a signed-in or unknown profile, or a fleet that fails or is slow, adds nothing: the response is exactly the run', async () => {
    hosts.mockResolvedValue([fabricHost(HOME, 'home-pc', { default: 'signed_in' })]);
    const signedIn = await start({ hostId: HOME });
    expect('warnings' in signedIn).toBe(false);
    expect(runResponseSchema.safeParse(signedIn).success).toBe(true);

    hosts.mockResolvedValue([fabricHost(HOME, 'home-pc', { default: 'unknown' }), fabricHost(OTHER, 'old', {}, { profiles: ['default'], profile_status: undefined })]);
    expect('warnings' in (await start({ hostId: HOME }))).toBe(false);
    expect('warnings' in (await start({}))).toBe(false);

    hosts.mockRejectedValue(new Error('fabric down'));
    const down = await start({ hostId: HOME });
    expect(down.status).toBe('queued');
    expect('warnings' in down).toBe(false);

    // A fabric slower than the deadline: the run is answered without waiting for it.
    hosts.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve([fabricHost(HOME, 'home-pc', { default: 'signed_out' })]), 10_000).unref()));
    const t0 = Date.now();
    const slow = await start({ hostId: HOME });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect('warnings' in slow).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(5);
    // The fabric call itself is bounded and cancelled at the deadline: nothing outlives the run start.
    const [opts] = hosts.mock.lastCall as [{ timeoutMs: number; retries: number; signal: AbortSignal }];
    expect(opts).toMatchObject({ timeoutMs: 1_500, retries: 0 });
    expect(opts.signal.aborted).toBe(true);
  });

  it('POST /tasks/{id}/runs warns for the task\'s machine and profile', async () => {
    hosts.mockResolvedValue([fabricHost(HOME, 'home-pc', { default: 'signed_out' })]);
    const created = await app.inject({ method: 'POST', url: '/api/tasks', headers: as(token), payload: { name: `Mail ${stamp}`, goal: 'Read my newest email', hostId: HOME } });
    expect(created.statusCode).toBe(201);
    const taskId = created.json<{ data: { id: string } }>().data.id;
    const res = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/runs`, headers: as(token), payload: {} });
    expect(res.statusCode).toBe(201);
    const run = res.json<{ data: { status: string; warnings?: unknown[] } }>().data;
    expect(run.warnings).toEqual([expect.objectContaining({ code: 'PROFILE_NOT_SIGNED_IN', hostId: HOME, profile: 'default' })]);
  });
});
