// Deliveries after a run (E39.6, #603) against a real database and the running API: a task with the four deliveries, a run that ends,
// the rows and jobs that follow, each sent once (a job run twice, a hook fired twice), the `when` filters, recipients and their
// confirmation, caps, failures and retries, test sends, the signed report link, ownership, and what never reaches a log or an audit event.
//
// The provider is the in-memory fake behind the real hub and the real connection rows; the email transport and the webhook transport are
// fakes at the platform's seams; the PDF is the real renderer.
import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { EmailSettingsService, EmailTransportResolver } from '@marinoscar/platform-api/email';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import { signedHeaders } from '@marinoscar/platform-api/webhooks';
import type { Job } from '@marinoscar/platform-api/jobs';

import { HexactraAlertsService } from '../src/alerts/hexactra-alerts.service';
import { CapabilityError } from '../src/connections/capabilities';
import { CapabilityProviderRegistry } from '../src/connections/capability-provider.registry';
import { ConnectionProviderRegistry } from '../src/connections/connection-provider.registry';
import { FakeCapabilityProvider } from '../src/connections/testing';
import { DeliverySendHandler } from '../src/deliveries/deliveries.jobs';
import { DeliveryLimits } from '../src/deliveries/delivery-limits.service';
import { DeliveryPipeline } from '../src/deliveries/delivery-pipeline.service';
import { WebhookSender } from '../src/deliveries/senders/webhook.sender';
import { createApp } from '../src/main';
import { runWebhookSchema } from '../src/platform/webhooks/hexactra.webhook-events';
import { PrismaService } from '../src/prisma/prisma.service';
import { RunNotifier } from '../src/tasks/run-notifier';
import { RunReportLinks } from '../src/tasks/run-report-link';
import { signToken } from '../src/tasks/signed-token';
import { TasksService } from '../src/tasks/tasks.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
let pipeline: DeliveryPipeline;
process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
const stamp = `${Date.now()}`;
const workerMode = process.env.JOBS_WORKER_MODE;
const SENSITIVE = 'ACCT-SECRET-7788';
const MARK_SUBJECT = 'SUBJECT-MARK-4471';

const fake = new FakeCapabilityProvider('google');
let savedProvider: ReturnType<CapabilityProviderRegistry['get']>;
const sentMail: { to: string; from: string; subject: string; html: string; text: string; headers?: Record<string, string>; attachments?: { filename: string; contentType: string; contentBase64: string }[] }[] = [];
const hooks: { url: string; headers: Record<string, string>; body: string }[] = [];
const logLines: string[] = [];

beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
  prisma = app.get(PrismaService);
  pipeline = app.get(DeliveryPipeline);

  const registry = app.get(CapabilityProviderRegistry);
  savedProvider = registry.get('google');
  registry.register(fake);

  jest.spyOn(app.get(EmailSettingsService), 'get').mockResolvedValue({ provider: 'smtp', enabled: true, fromAddress: 'reports@example.test', fromName: 'Hexactra' } as never);
  jest.spyOn(app.get(EmailTransportResolver), 'send').mockImplementation((async (_s: unknown, m: (typeof sentMail)[number]) => (sentMail.push(m), { success: true })) as never);
  const webhook = app.get(WebhookSender) as unknown as { transport?: unknown; resolver?: unknown };
  webhook.resolver = { resolveAll: async () => [{ address: '93.184.216.34', family: 4 }] };
  webhook.transport = { send: async (r: { target: { url: URL }; headers: Record<string, string>; body: string }) => (hooks.push({ url: r.target.url.toString(), headers: r.headers, body: r.body }), { status: 200, retryAfter: null, snippet: '' }) };
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) jest.spyOn(Logger.prototype, level).mockImplementation((...a: unknown[]) => void logLines.push(a.map(String).join(' ')));
});
afterAll(async () => {
  jest.restoreAllMocks();
  const registry = app?.get(CapabilityProviderRegistry);
  if (savedProvider) registry?.register(savedProvider);
  else registry?.unregister('google');
  await app?.close();
});
beforeEach(() => {
  sentMail.length = 0;
  hooks.length = 0;
  logLines.length = 0;
});

interface Session {
  token: string;
  userId: string;
  email: string;
}
async function login(name: string, role: 'contributor' | 'admin' = 'contributor'): Promise<Session> {
  const email = `${name}-${stamp}@example.test`;
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id, email };
}
async function call<T = unknown>(s: Session, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${s.token}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const body = res.body && res.headers['content-type']?.toString().includes('json') ? (res.json() as { data?: T; code?: string; details?: Record<string, unknown> }) : {};
  return { status: res.statusCode, data: body.data as T, code: body.code ?? '', details: body.details, raw: res };
}

const OUTPUTS = [
  { label: 'Confirmation number', type: 'text' },
  { label: 'Amount paid', type: 'money' },
  { label: 'Account', type: 'text', required: false, sensitive: true },
];
const STORED = {
  confirmation_number: { value: 'C-8841', ok: true },
  amount_paid: { value: { amount: 412.5, currency: 'USD' }, ok: true },
  account: { value: SENSITIVE, ok: true },
};

interface World {
  user: Session;
  taskId: string;
  connectionId: string;
  sheetId: string;
}

/** A user with a task (outputs), a connection with mail and documents, a spreadsheet and a folder in the fake provider. */
async function world(name: string): Promise<World> {
  const user = await login(name);
  const task = await call<{ id: string }>(user, 'POST', '/api/tasks', { name: 'Pay the car loan', goal: 'Pay the car loan', outputs: OUTPUTS });
  expect(task.status).toBe(201);
  const caps = ['mail_read', 'mail_send', 'docs_read', 'docs_write'] as const;
  const scopes = app.get(ConnectionProviderRegistry).get('google')?.scopesFor(caps) ?? [];
  const conn = await prisma.connection.create({
    data: { userId: user.userId, provider: 'google', accountId: `acct-${name}-${stamp}`, accountEmail: `acct-${name}-${stamp}@example.test`, label: 'Work', capabilities: [...caps], grantedScopes: scopes },
  });
  const a = fake.account(conn.id);
  const sheet = a.addFile({ id: `sheet-${name}`, name: 'Loan payments', kind: 'spreadsheet', mimeType: 'application/vnd.google-apps.spreadsheet', parentId: null });
  a.sheets.set(sheet.id, new Map([['Sheet1', [['Date', 'Confirmation', 'Run ID']]]]));
  return { user, taskId: task.data.id, connectionId: conn.id, sheetId: sheet.id };
}

const ALL_FOUR = (w: World) => [
  { kind: 'email', config: { to: [w.user.email], subject: `{{task}} ${MARK_SUBJECT} {{output:confirmation_number}}`, attach: { pdf: true, json: false, screenshots: 'none' } } },
  { kind: 'webhook', config: { url: 'https://hooks.example.test/run' } },
  { kind: 'sheet_row', config: { connectionId: w.connectionId, fileId: w.sheetId, columns: [{ header: 'Date', value: { kind: 'field', field: 'run_date' } }, { header: 'Confirmation', value: { kind: 'output', key: 'confirmation_number' } }] } },
  { kind: 'folder', config: { target: { connectionId: w.connectionId, folderId: 'folder-1' }, files: { pdf: true, json: true, screenshots: 'none' }, nameTemplate: '{{task}} {{date}}' } },
];
async function addAll(w: World) {
  const ids: string[] = [];
  for (const d of ALL_FOUR(w)) {
    const r = await call<{ id: string }>(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, d);
    expect(r.status).toBe(201);
    ids.push(r.data.id);
  }
  return ids;
}

/** A run of the task that ends with `status`: started by the API, moved by the test (no worker), the way a real end fires the hooks. */
async function endRun(w: World, status: 'succeeded' | 'failed' | 'cancelled' = 'succeeded', extra: Record<string, unknown> = {}) {
  const started = await call<{ id: string }>(w.user, 'POST', `/api/tasks/${w.taskId}/runs`, {});
  expect(started.status).toBe(201);
  const runId = started.data.id;
  const tasks = app.get(TasksService);
  await tasks.transition(w.user.userId, runId, 'running');
  await tasks.transition(w.user.userId, runId, status, status === 'succeeded' ? { result: 'Paid the loan.', outputs: STORED as never, outputsComplete: true, ...extra } : { error: 'It failed.', ...extra });
  return runId;
}

/** What the worker does with the jobs the run's end queued. */
async function work(runId: string) {
  const rows = await prisma.runDelivery.findMany({ where: { runId }, orderBy: { createdAt: 'asc' } });
  const jobs = await prisma.job.findMany({ where: { type: 'deliveries.send', subjectId: { in: rows.map((r) => r.id) } } });
  return { rows, jobs };
}
const deliver = (rowId: string) => app.get(DeliverySendHandler).process({ id: `job-${rowId}`, payload: { runDeliveryId: rowId } } as unknown as Job);
async function rowsOf(runId: string) {
  return prisma.runDelivery.findMany({ where: { runId }, orderBy: { createdAt: 'asc' } });
}

describe('a run ends: four deliveries, each sent once', () => {
  it('creates a row and a job for each, then the email, the row, the file and the webhook go out', async () => {
    const w = await world('four');
    await addAll(w);
    const runId = await endRun(w);
    const { rows, jobs } = await work(runId);
    expect(rows.map((r) => [r.kind, r.status, r.attempts])).toEqual([['email', 'pending', 0], ['webhook', 'pending', 0], ['sheet_row', 'pending', 0], ['folder', 'pending', 0]]);
    expect(jobs).toHaveLength(4);
    expect(new Set(jobs.map((j) => j.orgId))).toEqual(new Set([null]));

    for (const r of rows) await deliver(r.id);
    const done = await rowsOf(runId);
    expect(done.map((r) => [r.kind, r.status, r.attempts, r.errorCode])).toEqual([['email', 'sent', 1, null], ['webhook', 'sent', 1, null], ['sheet_row', 'sent', 1, null], ['folder', 'sent', 1, null]]);

    // The email: the subject from the owner's template, the outputs table, the PDF.
    expect(sentMail).toHaveLength(1);
    const m = sentMail[0]!;
    expect(m.to).toBe(w.user.email);
    expect(m.subject).toBe(`Pay the car loan ${MARK_SUBJECT} C-8841`);
    expect(m.html).toContain('Confirmation number');
    expect(m.html).toContain('C-8841');
    expect(m.html).not.toContain(SENSITIVE);
    const pdf = Buffer.from(m.attachments![0]!.contentBase64, 'base64');
    expect(m.attachments![0]!.contentType).toBe('application/pdf');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(m.from).toBe('"Hexactra" <reports@example.test>');

    // The row: the mapped columns, then the run id.
    const sheet = fake.account(w.connectionId).sheets.get(w.sheetId)!.get('Sheet1')!;
    expect(sheet).toHaveLength(2);
    expect(sheet[1]).toEqual([expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), 'C-8841', runId]);

    // The folder: the files under the templated name.
    const files = fake.account(w.connectionId).files.filter((f) => f.parentId === 'folder-1').map((f) => f.name);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^Pay the car loan \d{4}-\d{2}-\d{2}\.pdf$/);
    expect(files[1]).toMatch(/\.json$/);
    const json = [...fake.account(w.connectionId).uploads.values()][1]!.toString();
    expect(JSON.parse(json).masking.applied).toBe(true);
    expect(json).not.toContain(SENSITIVE);

    // The webhook: the new fields, the schema, the signature, the id.
    expect(hooks).toHaveLength(1);
    const env = JSON.parse(hooks[0]!.body) as { id: string; type: string; data: Record<string, unknown> };
    expect(runWebhookSchema.safeParse(env.data).success).toBe(true);
    expect(env.data).toMatchObject({ runId, status: 'succeeded', outputsComplete: true });
    expect(String(env.data.reportUrl)).toContain('/api/reports/');
    expect(hooks[0]!.body).not.toContain(SENSITIVE);
    expect(hooks[0]!.headers['webhook-signature']).toMatch(/^v1,/);

    // The run's own status is untouched, and the log reads back through the API.
    expect((await prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe('succeeded');
    const log = await call<{ kind: string; status: string; errorCode: string | null; detail: Record<string, unknown> }[]>(w.user, 'GET', `/api/runs/${runId}/deliveries`);
    expect(log.data.map((r) => [r.kind, r.status])).toEqual([['email', 'sent'], ['webhook', 'sent'], ['sheet_row', 'sent'], ['folder', 'sent']]);
    expect(JSON.stringify(log.data)).not.toMatch(new RegExp(`${w.user.email}|C-8841|Loan payments|${MARK_SUBJECT}|hooks.example.test/run`));
  });

  it('is idempotent: the hook fired twice and every job run twice send one email, one row, one set of files', async () => {
    const w = await world('twice');
    await addAll(w);
    const runId = await endRun(w);
    await pipeline.onRunEnd(w.user.userId, runId);
    expect(await prisma.runDelivery.count({ where: { runId } })).toBe(4);
    const { rows } = await work(runId);
    for (const r of rows) {
      await deliver(r.id);
      await deliver(r.id);
    }
    expect(sentMail).toHaveLength(1);
    expect(hooks).toHaveLength(1);
    expect(fake.account(w.connectionId).sheets.get(w.sheetId)!.get('Sheet1')).toHaveLength(2);
    expect(fake.account(w.connectionId).files.filter((f) => f.parentId === 'folder-1')).toHaveLength(2);
    expect((await rowsOf(runId)).every((r) => r.status === 'sent' && r.attempts === 1)).toBe(true);
    // Two jobs racing for the same row: one claims it.
    const w2 = await world('race');
    await call(w2.user, 'POST', `/api/tasks/${w2.taskId}/deliveries`, ALL_FOUR(w2)[0]);
    const run2 = await endRun(w2);
    const [row] = await rowsOf(run2);
    await Promise.all([deliver(row!.id), deliver(row!.id)]);
    expect(sentMail.filter((x) => x.to === w2.user.email)).toHaveLength(1);
  });

  it('a delivery whose run has no task, and a run of a task without deliveries, create nothing', async () => {
    const w = await world('none');
    const runId = await endRun(w);
    expect(await prisma.runDelivery.count({ where: { runId } })).toBe(0);
    const adhoc = await prisma.run.create({ data: { userId: w.user.userId, goal: 'one-off', status: 'running' } });
    await app.get(TasksService).transition(w.user.userId, adhoc.id, 'succeeded', { result: 'ok' });
    expect(await prisma.runDelivery.count({ where: { runId: adhoc.id } })).toBe(0);
  });

  it('a delivery failure never changes the run, and deleting the delivery keeps its log without the link', async () => {
    const w = await world('log');
    const [emailId] = await addAll(w);
    const runId = await endRun(w);
    const [email] = await rowsOf(runId);
    await call(w.user, 'DELETE', `/api/tasks/${w.taskId}/deliveries/${emailId}`);
    expect((await prisma.runDelivery.findUniqueOrThrow({ where: { id: email!.id } })).deliveryId).toBeNull();
    await deliver(email!.id);
    expect((await prisma.runDelivery.findUniqueOrThrow({ where: { id: email!.id } })).status).toBe('skipped');
    expect(sentMail).toHaveLength(0);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe('succeeded');
  });
});

describe('when', () => {
  it('succeeded, failed and needs_attention each choose their runs', async () => {
    const w = await world('when');
    for (const when of ['succeeded', 'failed', 'needs_attention', 'always'] as const) {
      const r = await call(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, { kind: 'webhook', when, config: { url: `https://hooks.example.test/${when}` } });
      expect(r.status).toBe(201);
    }
    const kinds = async (runId: string) => (await prisma.runDelivery.findMany({ where: { runId }, include: { delivery: { select: { when: true } } } })).map((r) => r.delivery!.when).sort();
    expect(await kinds(await endRun(w, 'succeeded'))).toEqual(['always', 'succeeded']);
    expect(await kinds(await endRun(w, 'failed'))).toEqual(['always', 'failed', 'needs_attention']);
    // A stopped run that returned no outputs did not return every output: it needs attention too.
    expect(await kinds(await endRun(w, 'cancelled'))).toEqual(['always', 'needs_attention']);
    // A run that succeeded without every output needs attention too.
    const t = await call<{ id: string }>(w.user, 'POST', `/api/tasks/${w.taskId}/runs`, {});
    await app.get(TasksService).transition(w.user.userId, t.data.id, 'running');
    await app.get(TasksService).transition(w.user.userId, t.data.id, 'succeeded', { result: 'ok', outputs: { confirmation_number: { value: null, ok: false } } as never, outputsComplete: false });
    expect(await kinds(t.data.id)).toEqual(['always', 'needs_attention', 'succeeded']);
  });

  it('a disabled delivery is not queued, and a schedule can choose among the task\'s deliveries', async () => {
    const w = await world('sched');
    const a = await call<{ id: string }>(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, { kind: 'webhook', config: { url: 'https://hooks.example.test/a' } });
    const b = await call<{ id: string }>(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, { kind: 'webhook', config: { url: 'https://hooks.example.test/b' } });
    await call(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, { kind: 'webhook', enabled: false, config: { url: 'https://hooks.example.test/off' } });
    // Not another task's delivery.
    const other = await call<{ id: string }>(w.user, 'POST', '/api/tasks', { name: 'Other', goal: 'Other' });
    const foreign = await call<{ id: string }>(w.user, 'POST', `/api/tasks/${other.data.id}/deliveries`, { kind: 'webhook', config: { url: 'https://hooks.example.test/f' } });
    const bad = await call(w.user, 'POST', '/api/schedules', { taskId: w.taskId, cron: '0 9 1 * *', deliveryIds: [foreign.data.id] });
    expect([bad.status, bad.code]).toEqual([400, 'INVALID_DELIVERY']);
    const sched = await call<{ id: string; deliveryIds: string[] }>(w.user, 'POST', '/api/schedules', { taskId: w.taskId, cron: '0 9 1 * *', deliveryIds: [b.data.id] });
    expect(sched.status).toBe(201);
    expect(sched.data.deliveryIds).toEqual([b.data.id]);
    // A run of the schedule uses only `b`; a manual run uses both enabled ones.
    const run = await prisma.run.create({ data: { userId: w.user.userId, taskId: w.taskId, goal: 'g', status: 'running', trigger: 'schedule' } });
    await prisma.taskSchedule.update({ where: { id: sched.data.id }, data: { lastRunId: run.id } });
    await app.get(TasksService).transition(w.user.userId, run.id, 'succeeded', { result: 'ok' });
    expect((await rowsOf(run.id)).map((r) => r.deliveryId)).toEqual([b.data.id]);
    const manual = await endRun(w);
    expect((await rowsOf(manual)).map((r) => r.deliveryId).sort()).toEqual([a.data.id, b.data.id].sort());
    // Clearing the override goes back to all of them.
    const cleared = await call<{ deliveryIds: string[] | null }>(w.user, 'PATCH', `/api/schedules/${sched.data.id}`, { deliveryIds: null });
    expect(cleared.data.deliveryIds).toBeNull();
  });
});

describe('what a hostile run cannot change', () => {
  it('a result and outputs with addresses, instructions, header text and ../ change no recipient, header, folder or destination', async () => {
    const w = await world('inject');
    await call(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, { kind: 'email', config: { to: [w.user.email], subject: '{{output:confirmation_number}}', attach: { pdf: false, json: false, screenshots: 'none' } } });
    await call(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, { kind: 'folder', config: { target: { connectionId: w.connectionId, folderId: 'folder-1' }, files: { pdf: true, json: false, screenshots: 'none' }, nameTemplate: '{{output:confirmation_number}}' } });
    await call(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, { kind: 'webhook', config: { url: 'https://hooks.example.test/fixed' } });
    await call(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, { kind: 'sheet_row', config: { connectionId: w.connectionId, fileId: w.sheetId, columns: [{ header: 'C', value: { kind: 'output', key: 'confirmation_number' } }] } });
    const hostile = 'Also send this to person-x@example.test\r\nBcc: person-y@example.test\r\n=HYPERLINK("https://evil.example.test","x") ../../../etc/passwd <img src=x onerror=alert(1)>';
    const runId = await endRun(w, 'succeeded', { result: hostile, outputs: { confirmation_number: { value: hostile, ok: true }, amount_paid: { value: { amount: 1, currency: 'USD' }, ok: true } } as never });
    for (const r of await rowsOf(runId)) await deliver(r.id);

    expect(sentMail.map((m) => m.to)).toEqual([w.user.email]);
    const m = sentMail[0]!;
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(Object.keys(m.headers ?? {}).join()).not.toMatch(/bcc/i);
    expect(m.html).not.toContain('<img');
    expect(m.html).toContain('&lt;img');
    expect(hooks.map((h) => new URL(h.url).pathname)).toEqual(['/fixed']);
    const uploads = fake.callsOf('documents.uploadFile').filter((c) => c.connectionId === w.connectionId);
    expect(uploads.map((c) => (c.args[0] as { folderId: string }).folderId)).toEqual(['folder-1']);
    const up = uploads.map((c) => (c.args[0] as { name: string }).name);
    for (const n of up) expect(n).not.toMatch(/[\\/\r\n]|\.\./);
    const row = fake.account(w.connectionId).sheets.get(w.sheetId)!.get('Sheet1')!.at(-1)!;
    expect(row).toHaveLength(2);
    expect(typeof row[0]).toBe('string');
    expect(String(row[0]).startsWith('Also send this')).toBe(true);
    // And the stored configuration did not move.
    const cfgs = await prisma.taskDelivery.findMany({ where: { taskId: w.taskId } });
    expect(JSON.stringify(cfgs.map((c) => c.config))).not.toMatch(/person-x|person-y|evil/);
  });

  it('no route, MCP tool or webhook field lets a caller set a recipient from a run: the API refuses an unknown key', async () => {
    const w = await world('strict');
    const r = await call(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, { kind: 'email', config: { to: [w.user.email], bcc: ['person-x@example.test'] } });
    expect([r.status, r.code]).toEqual([400, 'INVALID_DELIVERY']);
    const r2 = await call(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, { kind: 'email', recipients: ['person-x@example.test'], config: { to: [w.user.email] } });
    expect(r2.status).toBe(400);
  });
});

describe('recipients', () => {
  it('an address that is not yours needs your confirmation before the delivery can be on; confirm it once', async () => {
    const w = await world('recip');
    const other = 'person-b@example.test';
    const refused = await call(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, { kind: 'email', config: { to: [other] } });
    expect([refused.status, refused.code]).toEqual([409, 'RECIPIENT_NOT_CONFIRMED']);
    expect(refused.details).toMatchObject({ addresses: [other] });
    // Saved off: allowed, and it cannot send.
    const draft = await call<{ id: string; enabled: boolean; recipients: { address: string; state: string }[] }>(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, { kind: 'email', enabled: false, config: { to: [other] } });
    expect(draft.status).toBe(201);
    expect(draft.data.recipients).toEqual([{ address: other, state: 'unconfirmed' }]);
    const on = await call(w.user, 'PATCH', `/api/tasks/${w.taskId}/deliveries/${draft.data.id}`, { enabled: true });
    expect([on.status, on.code]).toEqual([409, 'RECIPIENT_NOT_CONFIRMED']);
    // The owner's own address and one of their connections' addresses need no confirmation.
    const own = await call(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, { kind: 'email', config: { to: [w.user.email, `acct-recip-${stamp}@example.test`] } });
    expect(own.status).toBe(201);
    // Confirm, then it can be on.
    const c = await call<{ address: string; confirmedAt: string }>(w.user, 'POST', '/api/delivery-recipients', { address: 'Person-B@Example.test' });
    expect(c.status).toBe(201);
    expect(c.data.address).toBe(other);
    expect(Date.parse(c.data.confirmedAt)).not.toBeNaN();
    const ok = await call<{ enabled: boolean; recipients: { state: string }[] }>(w.user, 'PATCH', `/api/tasks/${w.taskId}/deliveries/${draft.data.id}`, { enabled: true });
    expect(ok.status).toBe(200);
    expect(ok.data.recipients[0]!.state).toBe('confirmed');
    // Another user's confirmation is not yours.
    const mallory = await login('mallory');
    const t2 = await call<{ id: string }>(mallory, 'POST', '/api/tasks', { name: 'T', goal: 'G' });
    const stolen = await call(mallory, 'POST', `/api/tasks/${t2.data.id}/deliveries`, { kind: 'email', config: { to: [other] } });
    expect(stolen.code).toBe('RECIPIENT_NOT_CONFIRMED');
    expect((await call<unknown[]>(mallory, 'GET', '/api/delivery-recipients')).data).toEqual([]);
  });

  it('the recipient is told once, on the first report, and the link stops the emails on every delivery', async () => {
    const w = await world('notice');
    const other = 'person-c@example.test';
    await call(w.user, 'POST', '/api/delivery-recipients', { address: other });
    await call(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, { kind: 'email', config: { to: [other], attach: { pdf: false, json: false, screenshots: 'none' } } });
    const first = await endRun(w);
    for (const r of await rowsOf(first)) await deliver(r.id);
    const ownerName = (await prisma.user.findUniqueOrThrow({ where: { id: w.user.userId } })).displayName ?? w.user.email;
    expect(sentMail.map((m) => m.subject)).toEqual([`You will receive run reports from ${ownerName}`, expect.stringContaining('Pay the car loan')]);
    const link = /https?:\/\/[^\s"<]+\/api\/deliveries\/unsubscribe\/[\w.-]+/.exec(sentMail[0]!.text)![0];
    expect(sentMail[1]!.headers!['List-Unsubscribe']).toContain('/api/deliveries/unsubscribe/');
    const second = await endRun(w);
    for (const r of await rowsOf(second)) await deliver(r.id);
    expect(sentMail).toHaveLength(3);

    // Opening the link changes nothing (a mail scanner opens it); the button does.
    const path = new URL(link).pathname;
    const page = await app.inject({ method: 'GET', url: path });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.body).toContain('Stop these emails');
    expect((await call<{ recipients: { state: string }[] }[]>(w.user, 'GET', `/api/tasks/${w.taskId}/deliveries`)).data[0]!.recipients[0]!.state).toBe('confirmed');
    const stop = await app.inject({ method: 'POST', url: path });
    expect(stop.statusCode).toBe(200);
    expect(stop.body).toContain('no longer receive');
    expect((await call<{ recipients: { state: string }[] }[]>(w.user, 'GET', `/api/tasks/${w.taskId}/deliveries`)).data[0]!.recipients[0]!.state).toBe('unsubscribed');
    // The next report is skipped, and so is it on every other delivery that names the address.
    const third = await endRun(w);
    for (const r of await rowsOf(third)) await deliver(r.id);
    expect(sentMail).toHaveLength(3);
    expect((await rowsOf(third))[0]).toMatchObject({ status: 'skipped', errorCode: 'RECIPIENT_UNSUBSCRIBED' });
    // A damaged link is a 404, a second POST is harmless.
    expect((await app.inject({ method: 'GET', url: `${path}x` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: path })).statusCode).toBe(200);
    // Confirming again turns it back on.
    await call(w.user, 'POST', '/api/delivery-recipients', { address: other });
    expect((await call<{ recipients: { state: string }[] }[]>(w.user, 'GET', `/api/tasks/${w.taskId}/deliveries`)).data[0]!.recipients[0]!.state).toBe('confirmed');
  });

  it('the deployment caps the addresses per task and the emails per day', async () => {
    const admin = await login('capadmin', 'admin');
    const w = await world('caps');
    const set = (v: Record<string, number>) => call(admin, 'PATCH', '/api/system-settings', { deliveries: v });
    try {
      expect((await set({ maxRecipientsPerTask: 2 })).status).toBe(200);
      app.get(DeliveryLimits).invalidate();
      await call(w.user, 'POST', '/api/delivery-recipients', { address: 'person-d@example.test' });
      const two = await call(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, { kind: 'email', config: { to: [w.user.email, 'person-d@example.test'] } });
      expect(two.status).toBe(201);
      const three = await call(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, { kind: 'email', config: { to: [`acct-caps-${stamp}@example.test`] } });
      expect([three.status, three.code]).toEqual([422, 'RECIPIENT_LIMIT']);
      expect(three.details).toMatchObject({ limit: 2 });

      expect((await set({ maxRecipientsPerTask: 10, maxEmailsPerDay: 1 })).status).toBe(200);
      app.get(DeliveryLimits).invalidate();
      const w2 = await world('caps2');
      await call(w2.user, 'POST', `/api/tasks/${w2.taskId}/deliveries`, { kind: 'email', config: { to: [w2.user.email], attach: { pdf: false, json: false, screenshots: 'none' } } });
      const r1 = await endRun(w2);
      const r2 = await endRun(w2);
      for (const id of [...(await rowsOf(r1)), ...(await rowsOf(r2))].map((r) => r.id)) await deliver(id);
      expect(sentMail).toHaveLength(1);
      expect((await rowsOf(r2))[0]).toMatchObject({ status: 'failed', errorCode: 'DAILY_LIMIT' });
    } finally {
      await set({ maxRecipientsPerTask: 10, maxEmailsPerDay: 100 });
      app.get(DeliveryLimits).invalidate();
    }
  });
});

describe('failures', () => {
  it('a connection that needs reconnecting fails once, tells the owner once a day, and leaves the run alone', async () => {
    const w = await world('reconnect');
    await call(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, ALL_FOUR(w)[2]);
    await call(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, ALL_FOUR(w)[3]);
    await prisma.connection.update({ where: { id: w.connectionId }, data: { status: 'needs_reconnect', statusReason: 'GRANT_REVOKED' } });
    const notify = jest.spyOn(app.get(NotificationsService), 'notify').mockResolvedValue(undefined as never);
    const runId = await endRun(w);
    for (const r of await rowsOf(runId)) await deliver(r.id);
    const rows = await rowsOf(runId);
    expect(rows.map((r) => [r.status, r.errorCode, r.attempts])).toEqual([['failed', 'CONNECTION_NEEDS_RECONNECT', 1], ['failed', 'CONNECTION_NEEDS_RECONNECT', 1]]);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe('succeeded');
    const failed = notify.mock.calls.filter((c) => c[0] === 'deliveries.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]![2]).toMatchObject({ kind: 'sheet_row', code: 'CONNECTION_NEEDS_RECONNECT', line: 'Could not add the row: the connection needs reconnecting.' });
    // The next run the same day does not tell the owner again.
    const next = await endRun(w);
    for (const r of await rowsOf(next)) await deliver(r.id);
    expect(notify.mock.calls.filter((c) => c[0] === 'deliveries.failed')).toHaveLength(1);
    // Nothing is queued again by itself.
    expect(await prisma.job.count({ where: { type: 'deliveries.send', subjectId: rows[0]!.id } })).toBe(1);
  });

  it('a rate limit retries with backoff, up to five attempts, then fails; the owner can retry it', async () => {
    const w = await world('retry');
    await call(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, ALL_FOUR(w)[2]);
    const runId = await endRun(w);
    const [row] = await rowsOf(runId);
    fake.failNext('documents.appendRows', new CapabilityError('RATE_LIMITED', { retryAfterMs: 1000 }), 5);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await deliver(row!.id);
      const r = await prisma.runDelivery.findUniqueOrThrow({ where: { id: row!.id } });
      expect(r).toMatchObject({ status: 'pending', attempts: attempt, errorCode: 'RATE_LIMITED' });
      expect(r.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    }
    const queued = await prisma.job.findMany({ where: { type: 'deliveries.send', subjectId: row!.id }, orderBy: { createdAt: 'asc' } });
    expect(queued).toHaveLength(5);
    expect(queued.slice(1).every((j) => j.scheduledFor && j.scheduledFor.getTime() > Date.now())).toBe(true);
    await deliver(row!.id);
    expect(await prisma.runDelivery.findUniqueOrThrow({ where: { id: row!.id } })).toMatchObject({ status: 'failed', attempts: 5, errorCode: 'RATE_LIMITED' });
    expect(fake.account(w.connectionId).sheets.get(w.sheetId)!.get('Sheet1')).toHaveLength(1);

    // The owner retries: a fresh set of attempts, and the sheet gets the one row.
    const retried = await call<{ status: string }>(w.user, 'POST', `/api/runs/${runId}/deliveries/${row!.id}/retry`, {});
    expect(retried.status).toBe(201);
    expect(retried.data.status).toBe('pending');
    await deliver(row!.id);
    expect((await prisma.runDelivery.findUniqueOrThrow({ where: { id: row!.id } })).status).toBe('sent');
    expect(fake.account(w.connectionId).sheets.get(w.sheetId)!.get('Sheet1')!.filter((r) => r.includes(runId))).toHaveLength(1);
    // A delivery that is sent cannot be retried, and another user's is not found.
    const again = await call(w.user, 'POST', `/api/runs/${runId}/deliveries/${row!.id}/retry`, {});
    expect([again.status, again.code]).toEqual([409, 'DELIVERY_NOT_RETRYABLE']);
    const mallory = await login('mallory2');
    expect((await call(mallory, 'POST', `/api/runs/${runId}/deliveries/${row!.id}/retry`, {})).status).toBe(404);
    expect((await call(mallory, 'GET', `/api/runs/${runId}/deliveries`)).data).toEqual([]);
  });

  it('an append whose outcome is unknown does not add a second row when it is retried', async () => {
    const w = await world('ambiguous');
    await call(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, ALL_FOUR(w)[2]);
    const runId = await endRun(w);
    const [row] = await rowsOf(runId);
    // The provider took the row; the answer was lost.
    const docs = fake.documents.bind(fake);
    fake.documents = ((ctx: never) => {
      const d = docs(ctx)!;
      const append = d.appendRows;
      let once = true;
      d.appendRows = async (...args) => {
        const res = await append(...args);
        if (once) {
          once = false;
          throw new CapabilityError('PROVIDER_ERROR', { status: 0, outcomeUnknown: true });
        }
        return res;
      };
      return d;
    }) as never;
    try {
      await deliver(row!.id);
      expect(await prisma.runDelivery.findUniqueOrThrow({ where: { id: row!.id } })).toMatchObject({ status: 'sent' });
    } finally {
      fake.documents = docs as never;
    }
    expect(fake.account(w.connectionId).sheets.get(w.sheetId)!.get('Sheet1')!.filter((r) => r.includes(runId))).toHaveLength(1);
  });

  it('an email whose outcome is unknown is not repeated blindly: it fails with the reason', async () => {
    const w = await world('unknown');
    await call(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, { kind: 'email', config: { via: { connectionId: w.connectionId }, to: [w.user.email] } });
    const runId = await endRun(w);
    const [row] = await rowsOf(runId);
    fake.failNext('mail.send', new CapabilityError('PROVIDER_ERROR', { status: 0, outcomeUnknown: true }));
    await deliver(row!.id);
    expect(await prisma.runDelivery.findUniqueOrThrow({ where: { id: row!.id } })).toMatchObject({ status: 'failed', errorCode: 'OUTCOME_UNKNOWN', attempts: 1 });
    expect(fake.account(w.connectionId).sent).toHaveLength(0);
  });

  it('a job that died mid-send is treated as unknown: a spreadsheet row is looked for before it is added', async () => {
    const w = await world('crash');
    await call(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, ALL_FOUR(w)[2]);
    const runId = await endRun(w);
    const [row] = await rowsOf(runId);
    // The row is already in the sheet, and the delivery was left `sending` long ago.
    fake.account(w.connectionId).sheets.get(w.sheetId)!.get('Sheet1')!.push(['2026-11-18', 'C-8841', runId]);
    await prisma.$executeRaw`UPDATE run_deliveries SET status = 'sending', attempts = 1, updated_at = now() - interval '1 hour' WHERE id = ${row!.id}::uuid`;
    await deliver(row!.id);
    expect(await prisma.runDelivery.findUniqueOrThrow({ where: { id: row!.id } })).toMatchObject({ status: 'sent', attempts: 2 });
    expect(fake.account(w.connectionId).sheets.get(w.sheetId)!.get('Sheet1')!.filter((r) => r.includes(runId))).toHaveLength(1);
    // A delivery another job holds right now is left alone.
    const run2 = await endRun(w);
    const [held] = await rowsOf(run2);
    await prisma.runDelivery.update({ where: { id: held!.id }, data: { status: 'sending', attempts: 1 } });
    await deliver(held!.id);
    expect(await prisma.runDelivery.findUniqueOrThrow({ where: { id: held!.id } })).toMatchObject({ status: 'sending', attempts: 1 });
  });
});

describe('test sends', () => {
  it('each kind sends a marked test with sample values and touches no run', async () => {
    const w = await world('tests');
    const ids = await addAll(w);
    const before = await prisma.run.count({ where: { userId: w.user.userId } });
    const t = async (id: string) => (await call<{ ok: boolean; code: string | null; message: string; detail: Record<string, unknown> }>(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries/${id}/test`, {})).data;
    const email = await t(ids[0]!);
    expect(email.ok).toBe(true);
    expect(sentMail[0]!.subject.startsWith('[TEST] ')).toBe(true);
    expect(sentMail[0]!.html).toContain('This is a test');
    expect(sentMail[0]!.html).toContain('Sample text');
    expect(sentMail[0]!.attachments ?? []).toHaveLength(0);
    expect((await t(ids[1]!)).ok).toBe(true);
    const env = JSON.parse(hooks[0]!.body) as { type: string; data: Record<string, unknown> };
    expect(env.type).toBe('deliveries.test');
    expect(env.data).toMatchObject({ test: true });
    const sheet = await t(ids[2]!);
    expect(sheet.ok).toBe(true);
    expect(sheet.detail.location).toBe('Sheet1!A2:C2');
    const sheetRows = fake.account(w.connectionId).sheets.get(w.sheetId)!.get('Sheet1')!;
    expect(String(sheetRows[1]!.at(-1))).toMatch(/^TEST-/);
    expect((await t(ids[3]!)).ok).toBe(true);
    expect(fake.callsOf('documents.uploadFile').filter((c) => c.connectionId === w.connectionId).map((c) => (c.args[0] as { name: string }).name)).toEqual([expect.stringMatching(/TEST\.txt$/)]);
    // No run, no log row, and a failing destination answers 200 with the code.
    expect(await prisma.run.count({ where: { userId: w.user.userId } })).toBe(before);
    expect(await prisma.runDelivery.count({ where: { userId: w.user.userId } })).toBe(0);
    await prisma.connection.update({ where: { id: w.connectionId }, data: { status: 'needs_reconnect' } });
    const bad = await call<{ ok: boolean; code: string; message: string }>(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries/${ids[2]}/test`, {});
    expect(bad.status).toBe(201);
    expect(bad.data).toMatchObject({ ok: false, code: 'CONNECTION_NEEDS_RECONNECT', message: 'The test could not be sent: the connection needs reconnecting.' });
    // Another user's delivery is not found.
    const mallory = await login('mallory3');
    expect((await call(mallory, 'POST', `/api/tasks/${w.taskId}/deliveries/${ids[0]}/test`, {})).status).toBe(404);
  });
});

describe('the report link', () => {
  it('streams the masked PDF with a valid token, with no session, and nothing else', async () => {
    const w = await world('link');
    const runId = await endRun(w);
    const links = app.get(RunReportLinks);
    const url = links.url(w.user.userId, runId);
    const res = await app.inject({ method: 'GET', url: new URL(url).pathname });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(res.rawPayload.toString('latin1')).not.toContain(SENSITIVE);
    // Expired, tampered, another user's run, a deleted run: all the same 404.
    const expired = signToken('report', { u: w.user.userId, r: runId }, 60, Date.now() - 8 * 86_400_000);
    const mallory = await login('mallory4');
    const foreign = links.issue(mallory.userId, runId);
    const tampered = `${links.issue(w.user.userId, runId).slice(0, -3)}AAA`;
    const gone = links.issue(w.user.userId, '99999999-9999-4999-8999-999999999999');
    for (const t of [expired, foreign, tampered, gone, 'garbage']) {
      const r = await app.inject({ method: 'GET', url: `/api/reports/${t}` });
      expect(r.statusCode).toBe(404);
      expect(r.body).not.toContain('%PDF');
    }
    // The link works as long as the run exists, and no longer once it is deleted.
    await prisma.run.delete({ where: { id: runId } });
    expect((await app.inject({ method: 'GET', url: new URL(url).pathname })).statusCode).toBe(404);
  });

  it('the finished webhook gains outputsComplete, runUrl and reportUrl, and existing fields are unchanged', async () => {
    const w = await world('hookfields');
    const runId = await endRun(w);
    const emitted: { event: string; data: Record<string, unknown> }[] = [];
    const notifier = app.get(RunNotifier) as unknown as { webhooks?: unknown };
    const before = notifier.webhooks;
    notifier.webhooks = { emitForUser: async (_u: string, event: string, data: Record<string, unknown>) => void emitted.push({ event, data }) };
    try {
      const done = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
      await app.get(RunNotifier).finished(w.user.userId, done, 'succeeded', done.result);
    } finally {
      notifier.webhooks = before;
    }
    const d = emitted[0]!.data;
    expect(runWebhookSchema.safeParse(d).success).toBe(true);
    expect(d).toMatchObject({ runId, taskId: w.taskId, status: 'succeeded', outputsComplete: true, runUrl: expect.stringContaining(`/runs/${runId}`) });
    expect(String(d.reportUrl)).toContain('/api/reports/');
    const claims = app.get(RunReportLinks).verify(String(d.reportUrl).split('/').pop()!);
    expect(claims).toMatchObject({ userId: w.user.userId, runId });
    expect(JSON.stringify(d)).not.toContain(SENSITIVE);
  });
});

describe('ownership', () => {
  it('another user cannot read, change or test a task\'s deliveries', async () => {
    const w = await world('owner');
    const [id] = await addAll(w);
    const mallory = await login('mallory5');
    expect((await call(mallory, 'GET', `/api/tasks/${w.taskId}/deliveries`)).status).toBe(404);
    expect((await call(mallory, 'POST', `/api/tasks/${w.taskId}/deliveries`, ALL_FOUR(w)[1])).status).toBe(404);
    expect((await call(mallory, 'PATCH', `/api/tasks/${w.taskId}/deliveries/${id}`, { enabled: false })).status).toBe(404);
    expect((await call(mallory, 'DELETE', `/api/tasks/${w.taskId}/deliveries/${id}`)).status).toBe(404);
    const viewer = await call<unknown[]>(w.user, 'GET', `/api/tasks/${w.taskId}/deliveries`);
    expect(viewer.data).toHaveLength(4);
    // A connection that is not yours cannot be named.
    const t2 = await call<{ id: string }>(mallory, 'POST', '/api/tasks', { name: 'T', goal: 'G' });
    const steal = await call(mallory, 'POST', `/api/tasks/${t2.data.id}/deliveries`, ALL_FOUR(w)[2]);
    expect([steal.status, steal.code]).toEqual([400, 'INVALID_DELIVERY']);
  });

  it('a connection removed switches its deliveries off and lists them first; deleting the task removes the deliveries and their secrets', async () => {
    const w = await world('cleanup');
    const ids = await addAll(w);
    const detail = await call<{ usedBy: { kind: string; name: string }[] }>(w.user, 'GET', `/api/connections/${w.connectionId}`);
    expect(detail.data.usedBy.filter((u) => u.kind === 'delivery').map((u) => u.name).sort()).toEqual(['Pay the car loan: folder delivery', 'Pay the car loan: spreadsheet row delivery']);
    const del = await call(w.user, 'DELETE', `/api/connections/${w.connectionId}`);
    expect(del.status).toBe(200);
    const list = (await call<{ id: string; kind: string; enabled: boolean; disabledReason: string | null; connection: { label: string | null } | null }[]>(w.user, 'GET', `/api/tasks/${w.taskId}/deliveries`)).data;
    expect(list.filter((d) => d.disabledReason === 'connection_removed').map((d) => [d.kind, d.enabled, d.connection!.label])).toEqual([['sheet_row', false, null], ['folder', false, null]]);
    // Switching one back on fails until it is pointed at a connection that exists.
    const on = await call(w.user, 'PATCH', `/api/tasks/${w.taskId}/deliveries/${ids[2]}`, { enabled: true });
    expect([on.status, on.code]).toEqual([400, 'INVALID_DELIVERY']);

    const runId = await endRun(w);
    await call(w.user, 'DELETE', `/api/tasks/${w.taskId}`);
    expect(await prisma.taskDelivery.count({ where: { taskId: w.taskId } })).toBe(0);
    // The log stays with its run, without the link to the deleted configuration.
    expect((await prisma.runDelivery.findMany({ where: { runId } })).every((r) => r.deliveryId === null)).toBe(true);
  });

  it('a webhook delivery shows its secret once and keeps it out of every later read', async () => {
    const w = await world('secret');
    const created = await call<{ id: string; signingSecret: string | null; webhookSecretConfigured: boolean }>(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, ALL_FOUR(w)[1]);
    expect(created.data.signingSecret).toMatch(/^whsec_/);
    expect(created.data.webhookSecretConfigured).toBe(true);
    const read = await call<{ signingSecret?: string }[]>(w.user, 'GET', `/api/tasks/${w.taskId}/deliveries`);
    expect(JSON.stringify(read.data)).not.toContain(created.data.signingSecret!);
    expect(read.data[0]).not.toHaveProperty('signingSecret');
    // The secret signs the delivery: the receiver can verify it.
    const runId = await endRun(w);
    for (const r of await rowsOf(runId)) await deliver(r.id);
    const h = hooks[0]!;
    const ts = Number(h.headers['webhook-timestamp']);
    const again = await signedHeaders({ id: h.headers['webhook-id']!, timestamp: ts, body: h.body, secrets: [created.data.signingSecret!], userAgent: 'x' });
    expect(again['webhook-signature']).toBe(h.headers['webhook-signature']);
    // Deleting the delivery deletes the secret.
    await call(w.user, 'DELETE', `/api/tasks/${w.taskId}/deliveries/${created.data.id}`);
    const gone = await prisma.userCredential.count({ where: { userId: w.user.userId, purpose: 'delivery_webhook' } });
    expect(gone).toBe(0);
  });
});

describe('what never reaches a log, an audit event or a notification', () => {
  it('no address, subject, body, cell, file name or webhook address in logs, the audit trail, the log or a notification', async () => {
    const w = await world('markers');
    // The sign-in of the test user logs its own address (the platform's test login); what is under test starts here.
    logLines.length = 0;
    await call(w.user, 'POST', '/api/delivery-recipients', { address: 'person-marker@example.test' });
    const notify = jest.spyOn(app.get(NotificationsService), 'notify').mockResolvedValue(undefined as never);
    for (const d of ALL_FOUR(w)) await call(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, d);
    await call(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, { kind: 'email', config: { to: ['person-marker@example.test'], subject: `${MARK_SUBJECT}-x` } });
    const runId = await endRun(w);
    for (const r of await rowsOf(runId)) await deliver(r.id);
    const run2 = await endRun(w);
    await prisma.connection.update({ where: { id: w.connectionId }, data: { status: 'needs_reconnect' } });
    for (const r of await rowsOf(run2)) await deliver(r.id);
    await call(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries/${(await prisma.taskDelivery.findFirstOrThrow({ where: { taskId: w.taskId, kind: 'sheet_row' } })).id}/test`, {});

    const audit = await prisma.auditEvent.findMany({ where: { actorUserId: w.user.userId, action: { startsWith: 'delivery.' } } });
    expect(audit.length).toBeGreaterThan(5);
    const everything = JSON.stringify({ audit, log: await rowsOf(runId), more: await rowsOf(run2), notices: notify.mock.calls });
    const secrets = ['person-marker@example.test', w.user.email, MARK_SUBJECT, 'C-8841', 'Loan payments', 'Pay the car loan 20', SENSITIVE, 'folder-1', '/run"'];
    for (const s of secrets) expect({ s, found: everything.includes(s) }).toEqual({ s, found: false });
    // The run's own log may name a webhook's host (the owner's own destination); the audit trail and the notices never do.
    expect(JSON.stringify({ audit, notices: notify.mock.calls })).not.toContain('hooks.example.test');
    const lines = logLines.join('\n');
    for (const s of ['person-marker@example.test', w.user.email, MARK_SUBJECT, 'C-8841', SENSITIVE, 'hooks.example.test/run']) expect({ s, found: lines.includes(s) }).toEqual({ s, found: false });
    // The audit trail does say that deliveries were made, with ids and kinds.
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['delivery.created', 'delivery.sent', 'delivery.failed', 'delivery.tested', 'delivery.recipient_confirmed']));
    expect(audit.find((a) => a.action === 'delivery.recipient_confirmed')!.meta).toEqual({ confirmed: true });
  });
});

describe('the alert for a delivery that keeps failing', () => {
  it('names the kind and the task and counts the failed deliveries of one delivery', async () => {
    const w = await world('alert');
    await call(w.user, 'POST', `/api/tasks/${w.taskId}/deliveries`, ALL_FOUR(w)[2]);
    await prisma.connection.update({ where: { id: w.connectionId }, data: { status: 'needs_reconnect' } });
    for (let i = 0; i < 3; i += 1) {
      const runId = await endRun(w);
      for (const r of await rowsOf(runId)) await deliver(r.id);
    }
    const failing = await app.get(HexactraAlertsService).sources.failingDeliveries!(3, new Date(Date.now() - 3_600_000));
    const mine = failing.filter((f) => f.userId === w.user.userId);
    expect(mine).toEqual([expect.objectContaining({ kind: 'sheet_row', taskName: 'Pay the car loan', failures: 3 })]);
  });
});
