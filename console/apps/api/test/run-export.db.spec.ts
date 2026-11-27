// The db tier: `GET /runs/{id}/export` (#542) against a real, migrated and
// seeded database. A seeded run with sensitive values in every place a trace
// shows text exports a file that validates against the shipped JSON Schema,
// holds none of those values, never the transcript, embeds the stored
// pictures on request, and is written to the audit trail and the counter.
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrincipalCache } from '@marinoscar/platform-api/identity';
import type { Prisma } from '@prisma/client';

import { createApp } from '../src/main';
import { builtinPolicy } from '../src/policies/builtin-policies';
import { PrismaService } from '../src/prisma/prisma.service';
import { RunTraceService } from '../src/tasks/run-trace.service';
import { imageObjects, readPdf } from './helpers/pdf-read';
import { runTraceValidator } from './helpers/run-trace-schema';

let app: NestFastifyApplication;
let prisma: PrismaService;
let service: RunTraceService;
const stamp = `${Date.now()}`;
const logged: string[] = [];

/** The storage port: two stored (masked) pictures. */
const IMAGES: Record<string, Buffer> = {};
const store = {
  get: jest.fn(async (key: string) => (IMAGES[key] ? { bytes: IMAGES[key]!, contentType: 'image/jpeg' } : null)),
  put: jest.fn(async () => undefined),
  delete: jest.fn(async () => undefined),
};

// The values a run is seeded with; none may reach the file.
const CARD = '4111 1111 1111 1111';
const ACCOUNT = '123456789';
const EMAIL = 'person.a@example.test';
const TOKEN = `pat_${'a1B2'.repeat(10)}`;
const SECRET = 'S3cr3t-ANSWER-9182';
const TRANSCRIPT_MARKER = 'TRANSCRIPT-MARKER-7f3a';

beforeAll(async () => {
  app = await createApp({ docs: true });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  service = app.get(RunTraceService, { strict: false });
  Object.assign(service, { store });
  for (const level of ['log', 'warn'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(function (this: unknown, ...args: unknown[]) {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
});
afterAll(async () => {
  jest.restoreAllMocks();
  await app?.close();
});

type Session = { token: string; userId: string };
async function login(name: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `export-${name}-${stamp}@example.test`, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
const get = (s: Session, url: string) => app.inject({ method: 'GET', url: `/api${url}`, headers: { authorization: `Bearer ${s.token}` } });
const getPdf = async (s: Session, url: string) => {
  const res = await get(s, url);
  return { res, pdf: res.rawPayload };
};

/** A snapshot of the Balanced policy as the runner writes it at a run's first step. */
function snapshot(): Prisma.InputJsonValue {
  const balanced = builtinPolicy('builtin:balanced')!;
  return {
    schemaVersion: 1,
    ref: balanced.id,
    name: balanced.name,
    version: balanced.version,
    builtin: true,
    source: 'run',
    spec: balanced.spec,
    tiers: null,
    resolvedTiers: { standard: { model: 'openai:gpt-test' }, frontier: { model: 'openai:gpt-big' }, fast: { model: null } },
    takenAt: '2026-11-18T18:00:00.000Z',
    effectiveBudget: { limits: { actions: 60, modelCalls: 120, activeMinutes: 20, inputTokens: null, outputTokens: null, cost: 2 }, warnAtPercent: 80 },
    appLimits: { clientId: randomUUID(), clientName: 'App Alpha', allowedDomains: ['grant-only.example.test'], confirmPurchases: true },
  } as unknown as Prisma.InputJsonValue;
}

/** A chat run with a value to mask in every place a trace shows text, two stored pictures and a transcript. */
async function seed(userId: string, status: 'failed' | 'running' = 'failed'): Promise<string> {
  const conversation = await prisma.conversation.create({ data: { userId, title: 'Fares' } });
  await prisma.chatMessage.createMany({
    data: [
      { conversationId: conversation.id, seq: 1, role: 'user', kind: 'text', text: `Book it, mail ${EMAIL}` },
      { conversationId: conversation.id, seq: 2, role: 'assistant', kind: 'run', text: 'Starting a run' },
    ],
  });
  const run = await prisma.run.create({
    data: {
      userId,
      goal: 'Book the cheapest fare',
      status,
      trigger: 'chat',
      conversationId: conversation.id,
      result: status === 'failed' ? `Stopped. Receipt goes to ${EMAIL}` : null,
      error: status === 'failed' ? 'Ran out of actions' : null,
      stopReason: status === 'failed' ? 'budget_actions' : null,
      startedAt: new Date('2026-11-18T18:00:01Z'),
      finishedAt: status === 'failed' ? new Date('2026-11-18T18:04:00Z') : null,
      stepCount: 3,
      modelCalls: 7,
      policyRef: 'builtin:balanced',
      policyVersion: 1,
      policySource: 'run',
      policySnapshot: snapshot(),
      clientName: 'App Alpha',
      appLimits: { clientId: randomUUID(), allowedDomains: ['grant-only.example.test'] },
      transcript: [{ role: 'user', content: TRANSCRIPT_MARKER }],
      confirmedActions: [{ seq: 2, prompt: 'Pay now?', action: 'click', at: '2026-11-18T18:02:00.000Z' }],
    },
  });
  const expires = new Date(Date.now() + 3_600_000);
  const confirm = await prisma.question.create({
    data: { ownerUserId: userId, askedBy: `run:${run.id}`, runId: run.id, kind: 'confirmation', input: 'confirm', prompt: `Pay from account ${ACCOUNT}?`, risk: 'high', status: 'answered', expiresAt: expires, response: { outcome: 'completed', value: 'approve', valueWithheld: false, channel: 'web', answeredAt: '2026-11-18T18:01:30.000Z' } },
  });
  const code = await prisma.question.create({
    data: { ownerUserId: userId, askedBy: `run:${run.id}`, runId: run.id, kind: 'code', input: 'secret', prompt: 'Enter the code from your phone', status: 'answered', expiresAt: expires, response: { outcome: 'completed', value: SECRET, valueWithheld: false, channel: 'web', answeredAt: '2026-11-18T18:03:00.000Z' } },
  });
  const key = (seq: number, moment: string) => `runs/${userId}/${run.id}/${seq}-${moment}.jpg`;
  IMAGES[key(2, 'before_confirmed')] = Buffer.from(`jpeg-before-${run.id}`);
  IMAGES[key(6, 'final')] = Buffer.from(`jpeg-final-${run.id}`);
  // Step times a few seconds after the run's start, so the findings of the file (formatVersion 2: a slow start, the wait for the
  // owner) are the same on every run of the spec: with the default (now) they grew with the clock and broke the snapshot.
  const at = (seq: number) => new Date(Date.parse('2026-11-18T18:00:01Z') + seq * 2_000);
  await prisma.runStep.createMany({
    data: [
      { runId: run.id, seq: 1, createdAt: at(1), kind: 'action', action: 'navigate', args: { url: 'https://shop.example.test/pay', auth: TOKEN }, summary: `Typed card ${CARD}`, reasoning: `The card ${CARD} is on file`, durationMs: 800 },
      { runId: run.id, seq: 2, createdAt: at(2), kind: 'handoff', action: null, args: { kind: 'confirmation', input: 'confirm' }, summary: 'Asked to pay', questionId: confirm.id, screenshotKey: key(2, 'before_confirmed'), screenshotMoment: 'before_confirmed', screenshotMasked: 2, durationMs: 0 },
      { runId: run.id, seq: 3, createdAt: at(3), kind: 'handoff', action: 'answered', summary: 'The owner provided it', questionId: code.id, durationMs: 0 },
      { runId: run.id, seq: 4, createdAt: at(4), kind: 'routing', args: { from: 'standard', to: 'frontier', reason: 'stalled' }, summary: 'standard → frontier: stalled', durationMs: 0 },
      { runId: run.id, seq: 5, createdAt: at(5), kind: 'error', ok: false, summary: 'The page did not load', screenshotMoment: 'failure', screenshotNote: 'unavailable' },
      { runId: run.id, seq: 6, createdAt: at(6), kind: 'end', summary: 'Final screen', screenshotKey: key(6, 'final'), screenshotMoment: 'final', screenshotMasked: 0 },
    ],
  });
  return run.id;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
/** The file with ids, times and the console version replaced, for the snapshot. */
function normalized(file: Record<string, unknown>): unknown {
  return JSON.parse(
    JSON.stringify({ ...file, console: { version: '0.0.0' } })
      .replace(UUID, '<uuid>')
      .replace(ISO, '<time>'),
  );
}

describe('GET /runs/{id}/export', () => {
  it('sends a JSON attachment (no data envelope) that validates against the schema; a normalised snapshot', async () => {
    const user = await login('file');
    const id = await seed(user.userId);
    const res = await get(user, `/runs/${id}/export?format=json&screenshots=none`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="hexactra-run-${id.slice(0, 8)}-${day}.json"`);
    const file = res.json<Record<string, unknown> & { formatVersion: number; partial: boolean; findings: unknown[]; steps: { screenshot: Record<string, unknown> | null }[] }>();
    expect(file).not.toHaveProperty('data');
    const validate = runTraceValidator();
    expect(validate(file) ? [] : validate.errors).toEqual([]);
    expect(file.formatVersion).toBe(2);
    // Version 2 (#1047, #1071): the run's findings, as GET /runs/{id}/diagnostics answers them.
    const diagnostics = (await get(user, `/runs/${id}/diagnostics`)).json<{ data: { findings: unknown[] } }>().data.findings;
    expect(file.findings).toEqual(diagnostics);
    expect(file.partial).toBe(false);
    expect(normalized(file)).toMatchSnapshot();
  });

  it('holds none of the seeded sensitive values, never the transcript, an AI app limit or an object key', async () => {
    const user = await login('masked');
    const id = await seed(user.userId);
    const text = (await get(user, `/runs/${id}/export`)).body;
    for (const value of [CARD, ACCOUNT, EMAIL, TOKEN, SECRET, TRANSCRIPT_MARKER, 'grant-only.example.test', 'screenshotKey', `runs/${user.userId}`]) expect(text).not.toContain(value);
    const file = JSON.parse(text) as { masking: { applied: boolean; hits: Record<string, number> }; steps: { question: { answer: { valueWithheld: boolean } } | null }[] };
    expect(file.masking.applied).toBe(true);
    // The card in a summary and a reasoning, the email in the result and the chat, the token in an argument, the account in a question.
    expect(file.masking.hits).toEqual({ card: 2, email: 2, token: 1, account: 1 });
    expect(file.steps[2]!.question!.answer.valueWithheld).toBe(true);
  });

  it('screenshots=none keeps the picture facts without data; embed carries base64 of the stored bytes', async () => {
    const user = await login('images');
    const id = await seed(user.userId);
    type Shot = { moment: string; masked: number | null; note: string | null; contentType: string | null; bytes: number | null; data?: string } | null;
    const none = (await get(user, `/runs/${id}/export?screenshots=none`)).json<{ steps: { seq: number; screenshot: Shot }[] }>();
    expect(none.steps.map((s) => s.screenshot)).toEqual([
      null,
      { moment: 'before_confirmed', masked: 2, note: null, contentType: 'image/jpeg', bytes: null },
      null,
      null,
      { moment: 'failure', masked: null, note: 'unavailable', contentType: null, bytes: null },
      { moment: 'final', masked: 0, note: null, contentType: 'image/jpeg', bytes: null },
    ]);
    const embed = (await get(user, `/runs/${id}/export`)).json<{ steps: { seq: number; screenshot: Shot }[] }>();
    const before = embed.steps[1]!.screenshot!;
    expect(Buffer.from(before.data!, 'base64').toString()).toBe(`jpeg-before-${id}`);
    expect(before.bytes).toBe(`jpeg-before-${id}`.length);
    expect(Buffer.from(embed.steps[5]!.screenshot!.data!, 'base64').toString()).toBe(`jpeg-final-${id}`);
    expect(embed.steps[4]!.screenshot).not.toHaveProperty('data');
  });

  it('answers 413 EXPORT_TOO_LARGE past the size limit with the images, and not without them', async () => {
    const user = await login('large');
    const id = await seed(user.userId);
    const failed = await service.build(user.userId, id, { screenshots: 'embed', maxBytes: 10 }).catch((e: unknown) => e);
    expect((failed as { getStatus(): number }).getStatus()).toBe(413);
    expect((failed as { getResponse(): unknown }).getResponse()).toMatchObject({ code: 'EXPORT_TOO_LARGE', message: expect.stringContaining('screenshots=none') });
    const small = await service.build(user.userId, id, { screenshots: 'none', maxBytes: 10 });
    expect(small.steps).toHaveLength(6);
  });

  it("answers 404 RUN_NOT_FOUND for another user's run, and 400 for a malformed id", async () => {
    const owner = await login('owner');
    const other = await login('other');
    const id = await seed(owner.userId);
    const res = await get(other, `/runs/${id}/export`);
    expect([res.statusCode, res.json<{ code?: string }>().code]).toEqual([404, 'RUN_NOT_FOUND']);
    expect((await get(other, `/runs/${randomUUID()}/export`)).statusCode).toBe(404);
    expect((await get(other, '/runs/not-a-uuid/export')).statusCode).toBe(400);
  });

  it('needs runs:read: a member whose role lacks it gets 403, nobody anonymous gets in', async () => {
    const user = await login('norights');
    const id = await seed(user.userId);
    const role = await prisma.role.create({ data: { name: `export-norights-${stamp}`, scope: 'org', description: 'Test role without permissions' } });
    await prisma.membership.updateMany({ where: { userId: user.userId }, data: { roleId: role.id } });
    // As a write to memberships must (the platform's rule): the cached principal goes, so the next request reads the new role.
    app.get(PrincipalCache, { strict: false }).invalidateUser(user.userId);
    expect((await get(user, `/runs/${id}/export`)).statusCode).toBe(403);
    expect((await get(user, `/runs/${id}`)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/runs/${id}/export` })).statusCode).toBe(401);
  });

  it('exports a live run with partial: true', async () => {
    const user = await login('live');
    const id = await seed(user.userId, 'running');
    const file = (await get(user, `/runs/${id}/export?screenshots=none`)).json<{ partial: boolean; run: { status: string; finishedAt: string | null } }>();
    expect(file).toMatchObject({ partial: true, run: { status: 'running', finishedAt: null } });
    await prisma.run.update({ where: { id }, data: { status: 'cancelled', finishedAt: new Date() } });
  });

  it('writes the audit event and the counter; the log line has no goal, result or step text', async () => {
    const user = await login('audit');
    const id = await seed(user.userId);
    const metrics = (service as unknown as { metrics: { exported: (...a: unknown[]) => void } }).metrics;
    const counted = jest.spyOn(metrics, 'exported');
    logged.length = 0;
    await get(user, `/runs/${id}/export?screenshots=none`);
    expect(counted).toHaveBeenCalledWith('json', 'none');
    const events = await prisma.auditEvent.findMany({ where: { actorUserId: user.userId, action: 'runs.exported' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ targetType: 'run', targetId: id });
    expect(events[0]!.meta).toMatchObject({ runId: id, format: 'json', screenshots: 'none', partial: false });
    const line = logged.find((l) => l.startsWith('runs.export '));
    expect(line).toMatch(new RegExp(`^runs\\.export user=${user.userId} run=${id} format=json screenshots=none bytes=\\d+ ms=\\d+$`));
    for (const text of [JSON.stringify(events), ...logged]) {
      expect(text).not.toContain('Book the cheapest fare');
      expect(text).not.toContain('Receipt goes');
      expect(text).not.toContain('Typed card');
    }
  });

  it('allows 10 exports a minute per user, then answers 429 EXPORT_RATE_LIMITED', async () => {
    const user = await login('rate');
    const id = await seed(user.userId);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await get(user, `/runs/${id}/export?screenshots=none`)).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    const last = await get(user, `/runs/${id}/export?screenshots=none`);
    expect(codes[10]).toBe(429);
    expect([last.statusCode, last.json<{ code?: string }>().code]).toEqual([429, 'EXPORT_RATE_LIMITED']);
  });

  it('is in the OpenAPI document with its query and the file schema', async () => {
    const doc = (await app.inject({ method: 'GET', url: '/api/openapi.json' })).json<{ paths: Record<string, { get?: { parameters?: { name: string }[] } }> }>();
    const op = doc.paths['/api/runs/{id}/export']?.get;
    expect(op?.parameters?.map((p) => p.name).sort()).toEqual(['format', 'id', 'paper', 'screenshots']);
  });
});

describe('GET /runs/{id}/export?format=pdf (#543)', () => {
  it('sends a PDF attachment that holds the goal, the questions, the answers and the footer, and none of the seeded sensitive values', async () => {
    const user = await login('pdf');
    const id = await seed(user.userId);
    const { res, pdf } = await getPdf(user, `/runs/${id}/export?format=pdf`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toBe('no-store');
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="hexactra-run-${id.slice(0, 8)}-${day}.pdf"`);
    const read = readPdf(pdf);
    const text = read.text.join('\n').replace(/\s+/g, ' ');
    expect(read.pages).toBeGreaterThanOrEqual(1);
    expect(read.sizes[0]).toEqual([595.28, 841.89]);
    expect(read.info).toMatchObject({ Title: 'Run report: Book the cheapest fare', Author: 'Hexactra' });
    for (const want of ['Book the cheapest fare', 'Pay from account', 'Enter the code from your phone', 'Allowed', 'Provided (not recorded)', 'Sensitive data masked. Not a bank or legal record.', 'Failed: The page did not load', 'You confirmed 1 step']) {
      expect(text).toContain(want);
    }
    for (const value of [CARD, ACCOUNT, EMAIL, TOKEN, SECRET, TRANSCRIPT_MARKER, 'grant-only.example.test', `runs/${user.userId}`]) expect(text).not.toContain(value);
    // The two stored pictures of the seed are not real images: named in their captions, never embedded.
    expect(imageObjects(pdf)).toBe(0);
    expect(text).toContain('the picture could not be read');
  });

  it('paper=letter changes the page size; a live run prints the partial banner', async () => {
    const user = await login('pdf-live');
    const id = await seed(user.userId, 'running');
    const read = readPdf((await getPdf(user, `/runs/${id}/export?format=pdf&paper=letter&screenshots=none`)).pdf);
    expect(read.sizes.every(([w, h]) => w === 612 && h === 792)).toBe(true);
    expect(read.text.join(' ').replace(/\s+/g, ' ')).toContain('Run in progress: partial report');
    await prisma.run.update({ where: { id }, data: { status: 'cancelled', finishedAt: new Date() } });
  });

  it("answers 404 RUN_NOT_FOUND for another user's run, and 400 for an unknown paper", async () => {
    const owner = await login('pdf-owner');
    const other = await login('pdf-other');
    const id = await seed(owner.userId);
    const res = await get(other, `/runs/${id}/export?format=pdf`);
    expect([res.statusCode, res.json<{ code?: string }>().code]).toEqual([404, 'RUN_NOT_FOUND']);
    expect((await get(owner, `/runs/${id}/export?format=pdf&paper=a3`)).statusCode).toBe(400);
  });

  it('writes the audit event with format pdf and the counter; the log line has no goal or step text', async () => {
    const user = await login('pdf-audit');
    const id = await seed(user.userId);
    const metrics = (service as unknown as { metrics: { exported: (...a: unknown[]) => void } }).metrics;
    const counted = jest.spyOn(metrics, 'exported');
    logged.length = 0;
    const { res } = await getPdf(user, `/runs/${id}/export?format=pdf&screenshots=none&paper=letter`);
    expect(res.statusCode).toBe(200);
    expect(counted).toHaveBeenCalledWith('pdf', 'none');
    const events = await prisma.auditEvent.findMany({ where: { actorUserId: user.userId, action: 'runs.exported' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ targetType: 'run', targetId: id });
    expect(events[0]!.meta).toMatchObject({ runId: id, format: 'pdf', screenshots: 'none', paper: 'letter', partial: false });
    const line = logged.find((l) => l.startsWith('runs.export ') && l.includes('format=pdf'));
    expect(line).toMatch(new RegExp(`^runs\\.export user=${user.userId} run=${id} format=pdf screenshots=none paper=letter bytes=\\d+ ms=\\d+$`));
    for (const text of [JSON.stringify(events), ...logged]) {
      expect(text).not.toContain('Book the cheapest fare');
      expect(text).not.toContain('Typed card');
    }
  });
});
