// A takeover asked on Google's account sign-in page (E48.5, #931), against a real database: the mirrored question
// carries the run's host and profile (from the page URL the fabric reports and the fabric's session), so the card links
// to that profile's guided sign-in. Any other page or input carries nothing, and the agent's view is unchanged.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { FabricClient } from '../src/fabric/fabric.client';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { QuestionsService } from '../src/questions/questions.service';
import { FabricSession } from '../src/runner/fabric-session';

let app: NestFastifyApplication;
let prisma: PrismaService;
let questions: QuestionsService;
const stamp = `${Date.now()}`;
const HOST = randomUUID();
const SESSION = randomUUID();
const GOOGLE = 'https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmail.google.com';
let request: jest.SpiedFunction<FabricClient['request']>;

async function login(email: string): Promise<{ token: string; userId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  questions = app.get(QuestionsService, { strict: false });
  const fabric = app.get(FabricClient);
  jest.spyOn(fabric, 'hosts').mockResolvedValue([]);
  request = jest.spyOn(fabric, 'request').mockImplementation((async (method: string, path: string) => {
    if (method === 'GET' && path === `/v1/sessions/${SESSION}`) return { id: SESSION, host_id: HOST, profile: 'work' };
    if (method === 'POST' && path === `/v1/sessions/${SESSION}/handoffs`) {
      return { handoff: { id: randomUUID(), viewer_url: null, page: { title: 'Sign in - Google Accounts', url: GOOGLE }, expires_at: new Date(Date.now() + 600_000).toISOString() } };
    }
    throw new Error(`unexpected ${method} ${path}`);
  }) as never);
});
afterAll(async () => {
  await app?.close();
});

describe('a takeover on a Google sign-in page', () => {
  it('links to the guided sign-in of the run\'s host and profile; nothing else does', async () => {
    const u = await login(`q-signin-${stamp}@example.test`);
    // The fabric's handoff answer carries the page URL; it is passed on, not stored.
    const created = await new FabricSession(app.get(FabricClient)).openHandoff(SESSION, { kind: 'login', prompt: 'Sign in to Google, then press Done', input: 'takeover', choices: [] } as never);
    expect(created.pageUrl).toBe(GOOGLE);

    const takeover = await questions.mirrorHandoff({ id: u.userId }, questions.parseSpec({ input: 'takeover', kind: 'login', prompt: 'Sign in to Google, then press Done' }), created, { askedBy: 'agent:test', runId: null, fabricSessionId: SESSION });
    expect(takeover.signin).toEqual({ hostId: HOST, profile: 'work' });
    const row = await prisma.question.findUniqueOrThrow({ where: { id: takeover.id } });
    expect(row.signin).toEqual({ hostId: HOST, profile: 'work' });
    // The page URL itself is not stored anywhere on the question.
    expect(JSON.stringify(row)).not.toContain('accounts.google.com');

    const other = (pageUrl: string | null, input: 'takeover' | 'none' | 'text' = 'takeover') =>
      questions.mirrorHandoff({ id: u.userId }, questions.parseSpec({ input, kind: 'other', prompt: 'Help' }), { id: randomUUID(), viewerUrl: null, pageTitle: null, pageUrl, expiresAt: null }, { askedBy: 'agent:test', runId: null, fabricSessionId: SESSION });
    expect((await other('https://shop.example.test/login')).signin).toBeNull();
    expect((await other(null)).signin).toBeNull();
    expect((await other(GOOGLE, 'none')).signin).toBeNull();
    expect((await other(GOOGLE, 'text')).signin).toBeNull();
    // Without a session (a free-standing question) there is no machine to link to.
    const loose = await questions.mirrorHandoff({ id: u.userId }, questions.parseSpec({ input: 'takeover', kind: 'login', prompt: 'x' }), { id: randomUUID(), viewerUrl: null, pageTitle: null, pageUrl: GOOGLE, expiresAt: null }, { askedBy: 'agent:test', runId: null, fabricSessionId: null });
    expect(loose.signin).toBeNull();

    // The console reads it on the question and in the inbox.
    const headers = { authorization: `Bearer ${u.token}` };
    const one = await app.inject({ method: 'GET', url: `/api/questions/${takeover.id}`, headers });
    expect(one.json<{ data: { signin: unknown } }>().data.signin).toEqual({ hostId: HOST, profile: 'work' });
    const inbox = await app.inject({ method: 'GET', url: '/api/inbox', headers });
    const items = inbox.json<{ data: { questionId: string; signin?: unknown }[] }>().data;
    expect(items.find((i) => i.questionId === takeover.id)?.signin).toEqual({ hostId: HOST, profile: 'work' });
    expect(request).toHaveBeenCalledWith('GET', `/v1/sessions/${SESSION}`);
  });

  it('a fabric that does not answer for the session links nothing (and the question is still asked)', async () => {
    const u = await login(`q-signin-down-${stamp}@example.test`);
    const q = await questions.mirrorHandoff({ id: u.userId }, questions.parseSpec({ input: 'takeover', kind: 'login', prompt: 'x' }), { id: randomUUID(), viewerUrl: null, pageTitle: null, pageUrl: GOOGLE, expiresAt: null }, { askedBy: 'agent:test', runId: null, fabricSessionId: randomUUID() });
    expect(q.status).toBe('pending');
    expect(q.signin).toBeNull();
  });
});
