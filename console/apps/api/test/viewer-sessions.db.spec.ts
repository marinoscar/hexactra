// Remote desktop viewer sessions against a real database (#339): a session is
// bound to one host, one person and one organization; nginx's check
// (GET /api/fleet/desktop-auth) admits only that host's WebSocket path with
// that cookie while the person still holds fleet:desktop, then hands nginx
// a fabric tunnel; revoking, expiring or losing the permission ends it.
import { createHash } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { FabricError } from '../src/fabric/fabric.client';
import { DesktopViewerService } from '../src/fleet/desktop-viewer.service';
import { FleetService } from '../src/fleet/fleet.service';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';

const HOST = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const NO_DESKTOP = '66666666-6666-4666-8666-666666666666';

let app: NestFastifyApplication;
let prisma: PrismaService;
const fabricCalls: [string, string, unknown][] = [];
let fabricAnswer: () => unknown = () => ({ tunnel_id: 'tttttttt-0000-4000-8000-000000000001', connect_token: 'hxd_secret_connect_token' });

const fabricHost = (id: string, name: string, desktop: boolean) => ({
  id,
  name,
  version: '0.3.0',
  online: true,
  browser_connected: true,
  on_demand: true,
  mode: 'unattended',
  desktop,
  profiles: [],
  running_profiles: [],
  last_seen: new Date().toISOString(),
});

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  const fabric = {
    hosts: jest.fn(async () => [fabricHost(HOST, 'mini-pc', true), fabricHost(OTHER, 'other', true), fabricHost(NO_DESKTOP, 'attended', false)]),
    request: jest.fn(async (method: string, path: string, opts: { body?: unknown } = {}) => {
      fabricCalls.push([method, path, opts.body]);
      return fabricAnswer();
    }),
  };
  Object.assign(app.get(FleetService, { strict: false }), { fabric });
  Object.assign(app.get(DesktopViewerService, { strict: false }), { fabric });
});
afterAll(async () => {
  await app?.close();
});

async function login(email: string, role: string): Promise<{ token: string; id: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, id: me.json<{ data: { id: string } }>().data.id };
}

async function openSession(token: string, host = HOST) {
  const res = await app.inject({ method: 'POST', url: `/api/fleet/hosts/${host}/viewer-session`, headers: { authorization: `Bearer ${token}` } });
  const cookie = String(res.headers['set-cookie'] ?? '');
  return { res, cookie, value: /hx_desktop=([^;]+)/.exec(cookie)?.[1] ?? '' };
}

const check = (uri: string, cookie?: string) =>
  app.inject({ method: 'GET', url: '/api/fleet/desktop-auth', headers: { 'x-original-uri': uri, ...(cookie ? { 'x-desktop-cookie': cookie } : {}) } });

describe('remote desktop viewer sessions', () => {
  it('admits only that host with that cookie, and hands nginx a fabric tunnel', async () => {
    const admin = await login(`desk-${Date.now()}@example.test`, 'admin');
    const s = await openSession(admin.token);
    expect(s.res.statusCode).toBe(201);
    expect(s.res.json<{ data: { wsPath: string } }>().data.wsPath).toBe(`/viewer/${HOST}/websockify`);
    expect(s.cookie).toMatch(new RegExp(`^hx_desktop=[A-Za-z0-9_-]{43}; Path=/viewer/${HOST}/; Max-Age=3600; HttpOnly; SameSite=Strict`));
    // Only the hash is stored.
    const row = await prisma.viewerSession.findUniqueOrThrow({ where: { tokenHash: createHash('sha256').update(s.value).digest('hex') } });
    expect(row).toMatchObject({ hostId: HOST, userId: admin.id, revokedAt: null });

    const ok = await check(`/viewer/${HOST}/websockify`, s.value);
    expect(ok.statusCode).toBe(204);
    expect(ok.headers['x-desktop-tunnel']).toBe('tttttttt-0000-4000-8000-000000000001');
    expect(ok.headers['x-desktop-authorization']).toBe('Bearer hxd_secret_connect_token');
    const [method, path, body] = fabricCalls.at(-1)!;
    expect([method, path]).toEqual(['POST', `/v1/hosts/${HOST}/desktop-sessions`]);
    expect(body).toMatchObject({ actor: { user_id: admin.id } });
    expect((await prisma.viewerSession.findUniqueOrThrow({ where: { id: row.id } })).lastConnectAt).not.toBeNull();

    // Another host's path, no cookie, a made-up cookie, a path that is not the WebSocket: 401.
    expect((await check(`/viewer/${OTHER}/websockify`, s.value)).statusCode).toBe(401);
    expect((await check(`/viewer/${HOST}/websockify`)).statusCode).toBe(401);
    expect((await check(`/viewer/${HOST}/websockify`, 'made-up')).statusCode).toBe(401);
    expect((await check(`/viewer/${HOST}/vnc.html`, s.value)).statusCode).toBe(401);

    // Closing the page revokes it.
    const del = await app.inject({ method: 'DELETE', url: `/api/fleet/hosts/${HOST}/viewer-session`, headers: { authorization: `Bearer ${admin.token}` } });
    expect(del.statusCode).toBe(204);
    expect(String(del.headers['set-cookie'])).toContain('Max-Age=0');
    expect((await check(`/viewer/${HOST}/websockify`, s.value)).statusCode).toBe(401);
  });

  it('needs fleet:desktop to open, and re-checks it on every connect', async () => {
    const contributor = await login(`desk-c-${Date.now()}@example.test`, 'contributor');
    expect((await openSession(contributor.token)).res.statusCode).toBe(403);

    const admin = await login(`desk-r-${Date.now()}@example.test`, 'admin');
    const s = await openSession(admin.token);
    await prisma.user.update({ where: { id: admin.id }, data: { isActive: false } });
    const res = await check(`/viewer/${HOST}/websockify`, s.value);
    expect(res.statusCode).toBe(403);
    expect(res.headers['x-desktop-error']).toBe('DESKTOP_FORBIDDEN');
  });

  it('refuses expired sessions and hosts with no desktop; maps the fabric refusal for nginx', async () => {
    const admin = await login(`desk-e-${Date.now()}@example.test`, 'admin');
    const noDesktop = await openSession(admin.token, NO_DESKTOP);
    expect(noDesktop.res.statusCode).toBe(409);

    const s = await openSession(admin.token);
    fabricAnswer = () => {
      throw new FabricError('api', 'host mini-pc is offline', 409, 'host_offline');
    };
    const offline = await check(`/viewer/${HOST}/websockify`, s.value);
    expect(offline.statusCode).toBe(403);
    expect(offline.headers['x-desktop-error']).toBe('HOST_OFFLINE');
    fabricAnswer = () => ({ tunnel_id: 't', connect_token: 'hxd_x' });

    await prisma.viewerSession.updateMany({ where: { userId: admin.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await check(`/viewer/${HOST}/websockify`, s.value)).statusCode).toBe(401);
  });

  it('sweeps sessions a day after they end', async () => {
    const admin = await login(`desk-p-${Date.now()}@example.test`, 'admin');
    await openSession(admin.token);
    await prisma.viewerSession.updateMany({ where: { userId: admin.id }, data: { expiresAt: new Date(Date.now() - 2 * 24 * 3600_000) } });
    const viewer = app.get(DesktopViewerService, { strict: false });
    expect(await viewer.purge(new Date(Date.now() - 24 * 3600_000))).toBeGreaterThanOrEqual(1);
    expect(await prisma.viewerSession.count({ where: { userId: admin.id } })).toBe(0);
  });
});
