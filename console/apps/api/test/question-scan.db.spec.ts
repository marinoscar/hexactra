// A scan question (#924) against a real database, with an in-memory fabric: the server reads the page's address from the browser when the
// question opens (never from the asker), the live picture is captured on request and never stored, a browser that moved to another site
// gives no picture, the desktop source takes the node's screen, and only the signed-in web, Android app and Inbox answer it.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { handoffBody } from '../src/runner/fabric-handoff';
import { PrismaService } from '../src/prisma/prisma.service';
import { QuestionsService } from '../src/questions/questions.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
let questions: QuestionsService;
const stamp = `${Date.now()}`;

/** What the fake browser shows: the active tab's address, and the bytes of each kind of picture. */
const browser = { url: 'https://login.example-bank.com/qr?session=1', fail: false };
const PAGE_BYTES = Buffer.from('page-picture');
const DESKTOP_BYTES = Buffer.from('desktop-picture');
const actions: string[] = [];
const handoffs = new Map<string, { id: string; input: string }>();
const fabric = {
  request: jest.fn(async (method: string, path: string, opts: { body?: Record<string, unknown> } = {}) => {
    if (method === 'POST' && path.endsWith('/actions')) {
      const type = String((opts.body?.action as { type?: string } | undefined)?.type);
      actions.push(type);
      if (browser.fail) return { id: 'op', state: 'failed', error: 'no browser' };
      if (type === 'screenshot') return { id: 'op', state: 'succeeded', result: { artifact_id: 'page-art', mime: 'image/jpeg', url: browser.url, title: 'Bank' } };
      if (type === 'desktop_screenshot') return { id: 'op', state: 'succeeded', result: { artifact_id: 'desktop-art', mime: 'image/jpeg' } };
    }
    if (method === 'POST' && path.endsWith('/handoffs')) {
      const id = randomUUID();
      handoffs.set(id, { id, input: String(opts.body?.input) });
      return { handoff: { id, viewer_url: null, page: { title: 'Bank' }, expires_at: new Date(Date.now() + 180_000).toISOString() } };
    }
    if (method === 'POST' && path.endsWith('/respond')) return {};
    if (method === 'POST' && path.endsWith('/cancel')) return {};
    throw new Error(`unexpected ${method} ${path}`);
  }),
  raw: jest.fn(async (_method: string, path: string) => new Response(path.endsWith('desktop-art') ? DESKTOP_BYTES : PAGE_BYTES, { headers: { 'content-type': 'image/jpeg' } })),
  config: async () => ({ url: 'http://fabric.example.test', token: 't' }),
};

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  questions = app.get(QuestionsService, { strict: false });
  Object.assign(questions, { fabric, jobs: { enqueue: async () => undefined } });
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  browser.url = 'https://login.example-bank.com/qr?session=1';
  browser.fail = false;
  actions.length = 0;
});

async function login(email: string): Promise<{ token: string; userId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
const as = (token: string) => ({ authorization: `Bearer ${token}` });
type View = { id: string; status: string; input: string; scan: { source: string; domain: string | null; origin: string | null } | null; expiresAt: string; response: Record<string, unknown> | null };

/** A scan asked the way the runner and an external agent ask it: a fabric handoff, mirrored into the broker. */
async function askScan(userId: string, raw: Record<string, unknown>): Promise<View> {
  const spec = questions.parseSpec({ input: 'scan', kind: 'login', prompt: 'Scan the code with your banking app', ...raw });
  const h = await fabric.request('POST', `/v1/sessions/x/handoffs`, { body: { input: 'none' } });
  const handoff = (h as { handoff: { id: string } }).handoff;
  return (await questions.mirrorHandoff({ id: userId }, spec, { id: handoff.id, viewerUrl: null, pageTitle: 'Bank', expiresAt: new Date(Date.now() + 180_000) }, { askedBy: 'agent:x', runId: null, fabricSessionId: randomUUID() })) as unknown as View;
}

describe('a scan question (#924)', () => {
  it('reads the address from the browser when it opens, never from the asker, and waits 3 minutes by default', async () => {
    const a = await login(`scan-a-${stamp}@example.test`);
    // A domain or picture in the request is not part of the contract: dropped before the server fills its own.
    const spec = questions.parseSpec({ input: 'scan', kind: 'passkey', prompt: 'Scan', scan: { domain: 'attacker.test' }, image: 'data:image/png;base64,AAAA' } as Record<string, unknown>);
    expect(spec.scan).toEqual({ source: 'page', domain: null, origin: null });
    expect(spec.timeoutMs).toBe(180_000);
    expect(spec.timeoutDefaulted).toBeUndefined();
    const q = await askScan(a.userId, { scanSource: 'page' });
    expect(q.scan).toEqual({ source: 'page', domain: 'example-bank.com', origin: 'https://login.example-bank.com' });
    expect(actions).toEqual(['screenshot']);
    const row = await prisma.question.findUniqueOrThrow({ where: { id: q.id } });
    expect(row.scan).toEqual({ source: 'page', domain: 'example-bank.com', origin: 'https://login.example-bank.com' });
  });

  it('is refused without a browser (POST /api/questions): its picture is the browser', async () => {
    const a = await login(`scan-b-${stamp}@example.test`);
    const res = await app.inject({ method: 'POST', url: '/api/questions', headers: as(a.token), payload: { input: 'scan', kind: 'login', prompt: 'Scan' } });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('must belong to a browser session');
    const refused = await questions.create({ id: a.userId }, questions.parseSpec({ input: 'scan', kind: 'login', prompt: 'Scan' }), { askedBy: 'agent:x' }).catch((e: { getResponse: () => unknown }) => e.getResponse());
    expect(refused).toMatchObject({ code: 'SCAN_NEEDS_BROWSER' });
  });

  it('serves a fresh picture to its owner only, never stored, with the site in x-scan-domain', async () => {
    const a = await login(`scan-c-${stamp}@example.test`);
    const b = await login(`scan-c2-${stamp}@example.test`);
    const q = await askScan(a.userId, {});
    actions.length = 0;
    const res = await app.inject({ method: 'GET', url: `/api/questions/${q.id}/scan-image`, headers: as(a.token) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-scan-domain']).toBe('example-bank.com');
    expect(res.rawPayload.equals(PAGE_BYTES)).toBe(true);
    expect(actions).toEqual(['screenshot']);
    expect((await app.inject({ method: 'GET', url: `/api/questions/${q.id}/scan-image`, headers: as(b.token) })).statusCode).toBe(404);
    // Nothing of the picture is kept: the row holds the source and the address only.
    const row = await prisma.question.findUniqueOrThrow({ where: { id: q.id } });
    expect(JSON.stringify(row)).not.toContain('page-picture');
  });

  it('shows no picture once the browser is on another site, or when the address could not be read', async () => {
    const a = await login(`scan-d-${stamp}@example.test`);
    const q = await askScan(a.userId, {});
    browser.url = 'https://login.example-bank.com.evil.test/qr';
    const moved = await app.inject({ method: 'GET', url: `/api/questions/${q.id}/scan-image`, headers: as(a.token) });
    expect(moved.statusCode).toBe(409);
    expect(JSON.stringify(moved.json())).toContain('The browser is no longer on example-bank.com');
    expect(await questions.scanImage(a.userId, q.id).catch((e: { getResponse: () => unknown }) => e.getResponse())).toMatchObject({ code: 'SCAN_PAGE_CHANGED' });
    expect(moved.rawPayload.includes(PAGE_BYTES)).toBe(false);

    browser.fail = true;
    const unknown = await askScan(a.userId, {});
    expect(unknown.scan).toEqual({ source: 'page', domain: null, origin: null });
    browser.fail = false;
    const none = await app.inject({ method: 'GET', url: `/api/questions/${unknown.id}/scan-image`, headers: as(a.token) });
    expect(none.statusCode).toBe(409);
    expect(await questions.scanImage(a.userId, unknown.id).catch((e: { getResponse: () => unknown }) => e.getResponse())).toMatchObject({ code: 'SCAN_PAGE_UNKNOWN' });
    // A picture that could not be taken right now is a passing failure, not a refusal: the card tries again.
    browser.fail = true;
    browser.url = 'https://login.example-bank.com/qr';
    expect((await app.inject({ method: 'GET', url: `/api/questions/${q.id}/scan-image`, headers: as(a.token) })).statusCode).toBe(503);
  });

  it('takes the node desktop for Chrome\'s own passkey window, after checking the page', async () => {
    const a = await login(`scan-e-${stamp}@example.test`);
    const q = await askScan(a.userId, { kind: 'passkey', scanSource: 'desktop' });
    expect(q.scan?.source).toBe('desktop');
    actions.length = 0;
    const res = await app.inject({ method: 'GET', url: `/api/questions/${q.id}/scan-image`, headers: as(a.token) });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(DESKTOP_BYTES)).toBe(true);
    expect(actions).toEqual(['screenshot', 'desktop_screenshot']);
  });

  it('is answered with Done only on the web, the Android app and the Inbox; the picture stops once it is settled', async () => {
    const a = await login(`scan-f-${stamp}@example.test`);
    const q = await askScan(a.userId, {});
    for (const channel of ['cli', 'api', 'mcp', 'notification', 'webhook', 'mcp-oauth', 'mcp-app']) {
      const res = await app.inject({ method: 'POST', url: `/api/questions/${q.id}/answer`, headers: as(a.token), payload: { channel } });
      expect({ channel, status: res.statusCode }).toEqual({ channel, status: 403 });
    }
    const withValue = await app.inject({ method: 'POST', url: `/api/questions/${q.id}/answer`, headers: as(a.token), payload: { channel: 'web', value: 'x' } });
    expect(withValue.statusCode).toBe(400);
    const done = await app.inject({ method: 'POST', url: `/api/questions/${q.id}/answer`, headers: as(a.token), payload: { channel: 'android_app' } });
    expect(done.statusCode).toBe(200);
    expect(done.json<{ data: View }>().data).toMatchObject({ status: 'answered', response: { outcome: 'completed', channel: 'android_app' } });
    expect((await app.inject({ method: 'GET', url: `/api/questions/${q.id}/scan-image`, headers: as(a.token) })).statusCode).toBe(410);
  });

  it('opens a plain "none" handoff in the fabric: the scan is the console\'s card', async () => {
    expect(handoffBody({ kind: 'login', prompt: 'p', input: 'scan', timeoutMs: 180_000 } as never)).toMatchObject({ input: 'none' });
  });
});
