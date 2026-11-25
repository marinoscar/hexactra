// One-click guided profile sign-in (E48.4, #930) against a real database with a fake fabric: starting takes the takeover lease
// and opens the profile at Google's sign-in; the poll notices the sign-in, closes the browser so Chrome saves the profile, waits
// for the offline check, then gives the desktop back; cancel and the 15-minute limit give it back WITHOUT closing the browser;
// a run on the profile or someone else's takeover is a 409; without fleet:desktop a 403. The account email is shown to the
// person and never logged or put in an audit event.
import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { FabricError } from '../src/fabric/fabric.client';
import { DesktopViewerService } from '../src/fleet/desktop-viewer.service';
import { FleetService } from '../src/fleet/fleet.service';
import { GOOGLE_SIGNIN_URL, ProfileSigninService, SIGNIN_TIMEOUT_MS } from '../src/fleet/profile-signin.service';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';

const HOST = '7a7a7a7a-0000-4000-8000-000000000930';
const ATTENDED = '7a7a7a7a-0000-4000-8000-000000000931';
const EMAIL = 'owner.signin-930@example.com';

interface ProfileState {
  running: boolean;
  signin: 'signed_in' | 'signed_out' | 'expired' | 'unknown';
  checkedAt: string;
}

let app: NestFastifyApplication;
let prisma: PrismaService;
let profiles: Record<string, ProfileState>;
let lease: { lease_id: string; host_id: string; actor: { user_id: string; display_name?: string }; started_at: string; expires_at: string } | null;
let leaseSeq = 0;
let checkSeq = 0;
const commands: { type: string; profile?: string; url?: string }[] = [];
const leaseEvents: string[] = [];
const logged: string[] = [];

const check = () => `2026-11-25T10:00:${String(++checkSeq).padStart(2, '0')}Z`;
const fabricHost = (id: string, mode: string, desktop: boolean) => ({
  id,
  name: id === HOST ? 'mini-pc' : 'laptop',
  version: '0.4.0',
  online: true,
  browser_connected: true,
  on_demand: true,
  mode,
  desktop,
  profiles: Object.keys(profiles),
  running_profiles: Object.entries(profiles).filter(([, p]) => p.running).map(([n]) => n),
  profile_status: Object.entries(profiles).map(([name, p]) => ({
    name,
    running: p.running,
    signin: p.signin,
    accounts: p.signin === 'signed_in' ? [{ provider: 'google', email: EMAIL, state: 'signed_in' }] : [],
    checked_at: p.checkedAt,
  })),
  last_seen: new Date().toISOString(),
});

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  const fabric = {
    hosts: jest.fn(async () => [fabricHost(HOST, 'unattended', true), fabricHost(ATTENDED, 'attended', true)]),
    request: jest.fn(async (method: string, path: string, opts: { body?: { command?: { type: string; profile?: string; url?: string }; actor?: { user_id: string } } } = {}) => {
      if (path.endsWith('/takeover') && method === 'GET') {
        if (!lease) throw new FabricError('api', 'no takeover', 404);
        return lease;
      }
      if (path.endsWith('/takeover') && method === 'POST') {
        if (lease) throw new FabricError('api', 'held', 409, 'takeover_held');
        lease = { lease_id: `bbbbbbbb-0000-4000-8000-${String(++leaseSeq).padStart(12, '0')}`, host_id: HOST, actor: { user_id: opts.body!.actor!.user_id, display_name: 'Owner' }, started_at: new Date().toISOString(), expires_at: new Date(Date.now() + 300_000).toISOString() };
        leaseEvents.push(`take ${lease.lease_id}`);
        return lease;
      }
      if (/\/takeover\/[^/]+$/.test(path) && method === 'DELETE') {
        leaseEvents.push(`release ${path.split('/').at(-1)}`);
        lease = null;
        return undefined;
      }
      if (path.endsWith('/commands') && method === 'POST') {
        const c = opts.body!.command!;
        commands.push(c);
        // Closing a browser stops it; the agent's offline check then reads the profile on disk.
        if (c.type === 'close_browser' && profiles[c.profile!]) profiles[c.profile!] = { ...profiles[c.profile!]!, running: false, checkedAt: check() };
        if (c.type === 'show_profile' && profiles[c.profile!]) profiles[c.profile!]!.running = true;
        return { id: 'c1', host_id: HOST, command: c, state: 'succeeded', created_at: new Date().toISOString() };
      }
      throw new Error(`unexpected fabric call ${method} ${path}`);
    }),
  };
  Object.assign(app.get(FleetService, { strict: false }), { fabric });
  Object.assign(app.get(DesktopViewerService, { strict: false }), { fabric });
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(function (this: Logger, ...args: unknown[]) {
      logged.push(args.map(String).join(' '));
    });
  }
});
afterAll(async () => {
  jest.restoreAllMocks();
  await app?.close();
});
beforeEach(() => {
  profiles = { default: { running: false, signin: 'signed_out', checkedAt: check() }, work: { running: false, signin: 'signed_out', checkedAt: check() } };
  lease = null;
  commands.length = 0;
  leaseEvents.length = 0;
});

async function login(email: string, role: string): Promise<{ token: string; id: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, id: me.json<{ data: { id: string } }>().data.id };
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
interface View {
  id: string;
  status: string;
  phase: string | null;
  leaseId: string | null;
  signin: string;
  email: string | null;
  resultState: string | null;
  endReason: string | null;
}
const start = (token: string, profile = 'default', host = HOST, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `/api/fleet/hosts/${host}/profiles/${profile}/signin`, headers: auth(token), payload });
const poll = async (token: string, id: string) => {
  const res = await app.inject({ method: 'GET', url: `/api/fleet/signin-sessions/${id}`, headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return res.json<{ data: View }>().data;
};
const auditOf = (id: string) => prisma.auditEvent.findMany({ where: { targetType: 'profile_signin', targetId: id }, orderBy: { createdAt: 'asc' } });

describe('guided profile sign-in', () => {
  it('takes over, opens Google sign-in, then on success closes the browser, waits for the offline check and gives the desktop back', async () => {
    const owner = await login(`signin-ok-${Date.now()}@example.test`, 'admin');
    const res = await start(owner.token);
    expect(res.statusCode).toBe(201);
    const s = res.json<{ data: View }>().data;
    expect(s).toMatchObject({ status: 'started', phase: 'waiting', signin: 'signed_out', email: null });
    expect(s.leaseId).toBe(lease!.lease_id);
    expect(lease!.actor.user_id).toBe(owner.id);
    expect(commands).toEqual([{ type: 'show_profile', profile: 'default', url: GOOGLE_SIGNIN_URL }]);
    // The desktop cookie, scoped to the host, so the page connects at once.
    expect(String(res.headers['set-cookie'])).toMatch(new RegExp(`^hx_desktop=[A-Za-z0-9_-]{43}; Path=/viewer/${HOST}/; .*HttpOnly`));
    const row = await prisma.profileSigninSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row).toMatchObject({ userId: owner.id, hostId: HOST, profile: 'default', status: 'started' });
    expect(await prisma.viewerSession.findUniqueOrThrow({ where: { id: row.viewerSessionId! } })).toMatchObject({ revokedAt: null, hostId: HOST });

    // Still signing in: nothing moves, polling again is harmless.
    expect(await poll(owner.token, s.id)).toMatchObject({ status: 'started', phase: 'waiting' });
    expect(commands).toHaveLength(1);

    // The live check sees the sign-in: the page shows the account, the browser is closed so Chrome saves the profile.
    profiles.default = { running: true, signin: 'signed_in', checkedAt: check() };
    const signedIn = await poll(owner.token, s.id);
    expect(signedIn).toMatchObject({ signin: 'signed_in', email: EMAIL });
    expect(commands.at(-1)).toEqual({ type: 'close_browser', profile: 'default' });
    // The fake's close ran the offline check, so the same poll may already have finished; the next one certainly has.
    const done = signedIn.status === 'completed' ? signedIn : await poll(owner.token, s.id);
    expect(done).toMatchObject({ status: 'completed', phase: null, resultState: 'signed_in', email: EMAIL, leaseId: null });
    expect(leaseEvents).toEqual([`take ${s.leaseId}`, `release ${s.leaseId}`]);
    expect(lease).toBeNull();
    expect((await prisma.viewerSession.findUniqueOrThrow({ where: { id: row.viewerSessionId! } })).revokedAt).not.toBeNull();
    // Polling a finished session changes nothing.
    await poll(owner.token, s.id);
    expect(commands.filter((c) => c.type === 'close_browser')).toHaveLength(1);

    const events = await auditOf(s.id);
    expect(events.map((e) => e.action)).toEqual(['profile.signin.started', 'profile.signin.completed']);
    expect(events[1]!.meta).toMatchObject({ hostId: HOST, profile: 'default', resultState: 'signed_in' });
    expect(events.every((e) => e.actorUserId === owner.id)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(EMAIL);
    expect(logged.join('\n')).not.toContain(EMAIL);
  });

  it('waits in saving until the offline check after the close confirms it', async () => {
    const owner = await login(`signin-save-${Date.now()}@example.test`, 'admin');
    const s = (await start(owner.token)).json<{ data: View }>().data;
    profiles.default = { running: true, signin: 'signed_in', checkedAt: check() };
    const before = profiles.default.checkedAt;
    // A close that has not stopped the browser yet, and no newer check: the session waits in saving.
    const spy = jest.spyOn(FleetService.prototype, 'command').mockImplementationOnce(async (_h, c) => {
      commands.push(c);
      return { id: 'c', kind: c.type, profile: null, state: 'succeeded', error: null, createdAt: '', completedAt: null };
    });
    expect(await poll(owner.token, s.id)).toMatchObject({ status: 'started', phase: 'saving' });
    expect((await prisma.profileSigninSession.findUniqueOrThrow({ where: { id: s.id } })).closeCheckedAt).toBe(before);
    // The browser stopped but the node has not checked the profile since: still saving.
    profiles.default = { ...profiles.default, running: false };
    expect(await poll(owner.token, s.id)).toMatchObject({ status: 'started', phase: 'saving' });
    expect(lease).not.toBeNull();
    // The offline check reads it on disk: completed.
    profiles.default = { ...profiles.default, checkedAt: check() };
    expect(await poll(owner.token, s.id)).toMatchObject({ status: 'completed', resultState: 'signed_in' });
    expect(lease).toBeNull();
    spy.mockRestore();
  });

  it('cancel abandons it: lease released, browser left open, abandoned event', async () => {
    const owner = await login(`signin-cancel-${Date.now()}@example.test`, 'admin');
    const s = (await start(owner.token)).json<{ data: View }>().data;
    const res = await app.inject({ method: 'POST', url: `/api/fleet/signin-sessions/${s.id}/cancel`, headers: auth(owner.token), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: View }>().data).toMatchObject({ status: 'abandoned', endReason: 'cancelled', leaseId: null });
    expect(lease).toBeNull();
    expect(commands.map((c) => c.type)).toEqual(['show_profile']);
    expect(profiles.default!.running).toBe(true);
    const events = await auditOf(s.id);
    expect(events.map((e) => e.action)).toEqual(['profile.signin.started', 'profile.signin.abandoned']);
    expect(events[1]!.meta).toMatchObject({ hostId: HOST, profile: 'default', reason: 'cancelled' });
    // Cancelling again is harmless; another person cannot see or cancel it.
    expect((await app.inject({ method: 'POST', url: `/api/fleet/signin-sessions/${s.id}/cancel`, headers: auth(owner.token), payload: {} })).statusCode).toBe(200);
    const other = await login(`signin-other-${Date.now()}@example.test`, 'admin');
    expect((await app.inject({ method: 'GET', url: `/api/fleet/signin-sessions/${s.id}`, headers: auth(other.token) })).statusCode).toBe(404);
  });

  it('the expire job abandons a sign-in after 15 minutes without closing the browser', async () => {
    const owner = await login(`signin-timeout-${Date.now()}@example.test`, 'admin');
    const s = (await start(owner.token)).json<{ data: View }>().data;
    const signins = app.get(ProfileSigninService, { strict: false });
    expect(await signins.countDue()).toBe(0);
    await prisma.profileSigninSession.update({ where: { id: s.id }, data: { startedAt: new Date(Date.now() - SIGNIN_TIMEOUT_MS - 1000) } });
    expect(await signins.countDue()).toBeGreaterThanOrEqual(1);
    expect(await signins.expireDue()).toBeGreaterThanOrEqual(1);
    const row = await prisma.profileSigninSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row).toMatchObject({ status: 'abandoned', endReason: 'timeout' });
    expect(lease).toBeNull();
    expect(commands.map((c) => c.type)).toEqual(['show_profile']);
    expect((await auditOf(s.id)).map((e) => e.action)).toEqual(['profile.signin.started', 'profile.signin.abandoned']);
  });

  it('refuses a host someone else controls, a profile a run is using, and a host that is not an unattended desktop', async () => {
    const owner = await login(`signin-409-${Date.now()}@example.test`, 'admin');
    lease = { lease_id: 'cccccccc-0000-4000-8000-000000000001', host_id: HOST, actor: { user_id: '00000000-0000-4000-8000-0000000000ff', display_name: 'Someone' }, started_at: '', expires_at: '' };
    const held = await start(owner.token);
    expect(held.statusCode).toBe(409);
    expect(held.body).toContain('TAKEOVER_HELD');
    expect(commands).toHaveLength(0);
    lease = null;

    const run = await prisma.run.create({ data: { userId: owner.id, goal: 'check mail', profile: 'work', hostId: HOST, status: 'running' } });
    const busy = await start(owner.token, 'work');
    expect(busy.statusCode).toBe(409);
    expect(busy.body).toContain('PROFILE_IN_USE');
    expect(busy.body).toContain(`/runs/${run.id}`);
    expect(lease).toBeNull();
    expect(commands).toHaveLength(0);
    await prisma.run.update({ where: { id: run.id }, data: { status: 'succeeded' } });

    expect((await start(owner.token, 'default', ATTENDED)).statusCode).toBe(409);
    expect((await start(owner.token, 'missing')).statusCode).toBe(404);
    expect((await start(owner.token, 'Bad Name')).statusCode).toBe(400);
    expect((await start(owner.token, 'default', HOST, { unknown: true })).statusCode).toBe(400);
  });

  it('needs fleet:desktop', async () => {
    const contributor = await login(`signin-403-${Date.now()}@example.test`, 'contributor');
    expect((await start(contributor.token)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/fleet/signin-sessions/7a7a7a7a-0000-4000-8000-000000000999', headers: auth(contributor.token) })).statusCode).toBe(403);
    expect(lease).toBeNull();
    expect(commands).toHaveLength(0);
  });

  it('keeps the lease across profiles for a sign-in queue (E48.6), and the last one gives it back', async () => {
    const owner = await login(`signin-queue-${Date.now()}@example.test`, 'admin');
    const first = (await start(owner.token, 'default', HOST, { keepLease: true })).json<{ data: View }>().data;
    profiles.default = { running: true, signin: 'signed_in', checkedAt: check() };
    let v = await poll(owner.token, first.id);
    if (v.status !== 'completed') v = await poll(owner.token, first.id);
    expect(v).toMatchObject({ status: 'completed', leaseId: first.leaseId });
    expect(lease?.lease_id).toBe(first.leaseId);

    // The next profile adopts the lease the person holds.
    const second = (await start(owner.token, 'work')).json<{ data: View }>().data;
    expect(second.leaseId).toBe(first.leaseId);
    expect(leaseEvents).toEqual([`take ${first.leaseId}`]);
    await app.inject({ method: 'POST', url: `/api/fleet/signin-sessions/${second.id}/cancel`, headers: auth(owner.token), payload: {} });
    expect(lease).toBeNull();
    expect(leaseEvents).toEqual([`take ${first.leaseId}`, `release ${first.leaseId}`]);
    expect((await auditOf(second.id))[0]!.meta).toMatchObject({ adoptedLease: true });
  });
});
