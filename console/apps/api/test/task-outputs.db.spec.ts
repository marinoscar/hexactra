// Task outputs (E39.5, #600) against a real database: the definitions on a task, the copy on a run,
// the masked views (run, list, chat result, webhook, MCP, trace export), the per-task history and ownership.
import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TaskOutput } from '@app/shared/task-fields';

import { createApp } from '../src/main';
import { ChatResults } from '../src/chat/chat-results.service';
import { runWebhookSchema, RUN_FINISHED_WEBHOOK } from '../src/platform/webhooks/hexactra.webhook-events';
import { PrismaService } from '../src/prisma/prisma.service';
import { RunNotifier } from '../src/tasks/run-notifier';
import { TasksService } from '../src/tasks/tasks.service';

let app: NestFastifyApplication;
const stamp = `${Date.now()}`;
const MARK = 'SENSITIVE-OUT-7788-zq';
const workerMode = process.env.JOBS_WORKER_MODE;

beforeAll(async () => {
  // No job worker: runs started here are moved by the test, never driven.
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterAll(async () => {
  jest.restoreAllMocks();
  await app?.close();
});

async function login(email: string): Promise<{ token: string; userId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
const as = (token: string) => ({ authorization: `Bearer ${token}` });
const data = <T,>(res: { json: <U>() => U }): T => res.json<{ data: T }>().data;

const OUTPUTS = [
  { label: 'Confirmation number', type: 'text', help: 'On the receipt' },
  { label: 'Amount paid', type: 'money' },
  { label: 'Paid on', type: 'date' },
  { label: 'Account', type: 'text', required: false, sensitive: true },
];

async function createTask(token: string, outputs: unknown = OUTPUTS) {
  const res = await app.inject({ method: 'POST', url: '/api/tasks', headers: as(token), payload: { name: 'Pay the rent', goal: 'Pay the rent', outputs } });
  return { res, task: res.statusCode === 201 ? data<{ id: string; outputs: TaskOutput[] | null }>(res) : null };
}

/** A run started from the task by the API (it copies the task's outputs), then finished with `outputs`. */
async function finishedRun(who: { token: string; userId: string }, taskId: string, outputs: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  const started = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/runs`, headers: as(who.token), payload: {} });
  expect(started.statusCode).toBe(201);
  const runId = data<{ id: string }>(started).id;
  const tasks = app.get(TasksService);
  await tasks.transition(who.userId, runId, 'running');
  await tasks.transition(who.userId, runId, 'succeeded', { result: 'Paid the rent.', ...(outputs ? { outputs: outputs as never, outputsComplete: true } : {}), ...extra });
  return runId;
}

const STORED = {
  confirmation_number: { value: 'C-8841', ok: true },
  amount_paid: { value: { amount: 1250, currency: 'USD' }, ok: true },
  paid_on: { value: '2026-03-25', ok: true },
  account: { value: MARK, ok: true },
};

describe('task output definitions on the API', () => {
  it('creates a task with outputs (keys derived), returns them, and replaces or clears them on update', async () => {
    const alice = await login(`out-def-${stamp}@example.test`);
    const { res, task } = await createTask(alice.token);
    expect(res.statusCode).toBe(201);
    expect(task!.outputs).toEqual([
      { key: 'confirmation_number', label: 'Confirmation number', type: 'text', required: true, help: 'On the receipt' },
      { key: 'amount_paid', label: 'Amount paid', type: 'money', required: true },
      { key: 'paid_on', label: 'Paid on', type: 'date', required: true },
      { key: 'account', label: 'Account', type: 'text', required: false, sensitive: true },
    ]);
    expect(data<{ outputs: unknown[] }>(await app.inject({ method: 'GET', url: `/api/tasks/${task!.id}`, headers: as(alice.token) })).outputs).toHaveLength(4);

    const patched = await app.inject({ method: 'PATCH', url: `/api/tasks/${task!.id}`, headers: as(alice.token), payload: { outputs: [{ label: 'Amount', type: 'number' }] } });
    expect(data<{ outputs: { key: string }[] }>(patched).outputs).toEqual([{ key: 'amount', label: 'Amount', type: 'number', required: true }]);
    // Another field changes nothing about the outputs.
    const renamed = await app.inject({ method: 'PATCH', url: `/api/tasks/${task!.id}`, headers: as(alice.token), payload: { name: 'Pay rent' } });
    expect(data<{ outputs: unknown[] }>(renamed).outputs).toHaveLength(1);
    const cleared = await app.inject({ method: 'PATCH', url: `/api/tasks/${task!.id}`, headers: as(alice.token), payload: { outputs: [] } });
    expect(data<{ outputs: unknown }>(cleared).outputs).toBeNull();
  });

  it('refuses invalid definitions with a typed error', async () => {
    const alice = await login(`out-bad-${stamp}@example.test`);
    const dup = await createTask(alice.token, [{ key: 'a', label: 'A', type: 'text' }, { key: 'a', label: 'B', type: 'text' }]);
    expect(dup.res.statusCode).toBe(400);
    const err = dup.res.json<{ code?: string; error?: { code?: string } }>();
    expect(err.code ?? err.error?.code).toBe('INVALID_OUTPUTS');
    expect((await createTask(alice.token, [{ label: 'Pick', type: 'choice' }])).res.statusCode).toBe(400);
    expect((await createTask(alice.token, [{ label: 'X', type: 'nope' }])).res.statusCode).toBe(400);
    expect((await createTask(alice.token, Array.from({ length: 31 }, (_, i) => ({ label: `L${i}`, type: 'text' })))).res.statusCode).toBe(400);
  });
});

describe('what a run keeps and shows', () => {
  it('copies the definitions at its start, so editing the task never relabels an earlier run', async () => {
    const alice = await login(`out-copy-${stamp}@example.test`);
    const { task } = await createTask(alice.token);
    const first = await finishedRun(alice, task!.id, STORED);
    await app.inject({ method: 'PATCH', url: `/api/tasks/${task!.id}`, headers: as(alice.token), payload: { outputs: [{ key: 'confirmation_number', label: 'Reference', type: 'number' }] } });
    const second = await finishedRun(alice, task!.id, { confirmation_number: { value: 42, ok: true } });

    const old = data<{ outputs: { key: string; label: string; type: string }[] }>(await app.inject({ method: 'GET', url: `/api/runs/${first}`, headers: as(alice.token) }));
    expect(old.outputs.map((o) => [o.key, o.label, o.type])).toEqual([
      ['confirmation_number', 'Confirmation number', 'text'],
      ['amount_paid', 'Amount paid', 'money'],
      ['paid_on', 'Paid on', 'date'],
      ['account', 'Account', 'text'],
    ]);
    const fresh = data<{ outputs: { key: string; label: string; type: string }[] }>(await app.inject({ method: 'GET', url: `/api/runs/${second}`, headers: as(alice.token) }));
    expect(fresh.outputs.map((o) => [o.key, o.label, o.type])).toEqual([['confirmation_number', 'Reference', 'number']]);
    // The row holds its own copy, and the caller cannot redefine it: a start takes no outputs.
    const row = await app.get(PrismaService).run.findFirstOrThrow({ where: { id: first } });
    expect(row.outputsSpec).toHaveLength(4);
  });

  it('a run with no outputs defined has none', async () => {
    const alice = await login(`out-none-${stamp}@example.test`);
    const { task } = await createTask(alice.token, []);
    const id = await finishedRun(alice, task!.id, null);
    expect(data<{ outputs: unknown; outputsComplete: unknown }>(await app.inject({ method: 'GET', url: `/api/runs/${id}`, headers: as(alice.token) }))).toMatchObject({ outputs: null, outputsComplete: null });
  });

  it('marks a finished run that never returned them as incomplete, every output "not found"', async () => {
    const alice = await login(`out-never-${stamp}@example.test`);
    const { task } = await createTask(alice.token);
    const id = await finishedRun(alice, task!.id, null);
    const run = data<{ outputsComplete: boolean; outputs: { ok: boolean; note: string; value: unknown }[] }>(await app.inject({ method: 'GET', url: `/api/runs/${id}`, headers: as(alice.token) }));
    expect(run.outputsComplete).toBe(false);
    expect(run.outputs.every((o) => o.value === null && o.ok === false && o.note === 'Not found')).toBe(true);
  });
});

describe('a sensitive output is masked in every view (marker test)', () => {
  it('shows [hidden] in the run, never in the list, the chat result, the webhook, MCP, the trace file or the PDF', async () => {
    const alice = await login(`out-mask-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const { task } = await createTask(alice.token);
    const runId = await finishedRun(alice, task!.id, STORED);
    // Stored whole: a delivery the owner configured may carry it.
    expect(JSON.stringify((await prisma.run.findFirstOrThrow({ where: { id: runId } })).outputs)).toContain(MARK);

    // The run view.
    const view = await app.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: as(alice.token) });
    const run = data<{ outputs: { key: string; value: unknown; sensitive: boolean }[]; outputsComplete: boolean }>(view);
    expect(run.outputsComplete).toBe(true);
    expect(run.outputs.find((o) => o.key === 'account')).toMatchObject({ sensitive: true, value: '[hidden]' });
    expect(run.outputs.find((o) => o.key === 'amount_paid')!.value).toEqual({ amount: 1250, currency: 'USD' });
    expect(view.body).not.toContain(MARK);

    // The list: only `outputsComplete`.
    const list = await app.inject({ method: 'GET', url: '/api/runs?envelope=1&taskId=' + task!.id, headers: as(alice.token) });
    const row = data<{ items: Record<string, unknown>[] }>(list).items[0]!;
    expect(row).toMatchObject({ outputsComplete: true });
    expect(row).not.toHaveProperty('outputs');
    expect(row).not.toHaveProperty('outputsSpec');
    expect(list.body).not.toContain(MARK);

    // The chat result message.
    const chat = await prisma.conversation.create({ data: { userId: alice.userId, title: 'Rent' } });
    await prisma.run.update({ where: { id: runId }, data: { conversationId: chat.id } });
    await app.get(ChatResults).recordRunEnd(alice.userId, runId);
    const message = await prisma.chatMessage.findFirstOrThrow({ where: { conversationId: chat.id, kind: 'result' } });
    const meta = message.meta as { outputs: { key: string; value: unknown }[]; outputsComplete: boolean };
    expect(meta.outputsComplete).toBe(true);
    expect(meta.outputs.find((o) => o.key === 'account')!.value).toBe('[hidden]');
    expect(meta.outputs.find((o) => o.key === 'confirmation_number')!.value).toBe('C-8841');
    expect(JSON.stringify(message)).not.toContain(MARK);

    // The webhook payload, with and without outputs, against its schema.
    const emitted: { event: string; data: Record<string, unknown> }[] = [];
    const notifier = app.get(RunNotifier) as unknown as { webhooks?: unknown };
    const before = notifier.webhooks;
    notifier.webhooks = { emitForUser: async (_u: string, event: string, payload: Record<string, unknown>) => void emitted.push({ event, data: payload }) };
    try {
      const done = await prisma.run.findFirstOrThrow({ where: { id: runId } });
      await app.get(RunNotifier).finished(alice.userId, done, 'succeeded', done.result);
      await app.get(RunNotifier).finished(alice.userId, { id: runId, goal: 'g' }, 'succeeded', 'ok');
    } finally {
      notifier.webhooks = before;
    }
    expect(emitted.map((e) => e.event)).toEqual([RUN_FINISHED_WEBHOOK, RUN_FINISHED_WEBHOOK]);
    expect(runWebhookSchema.safeParse(emitted[0]!.data).success).toBe(true);
    expect(runWebhookSchema.safeParse(emitted[1]!.data).success).toBe(true);
    expect(emitted[0]!.data.outputs).toHaveLength(4);
    expect(emitted[1]!.data).not.toHaveProperty('outputs');
    expect(JSON.stringify(emitted[0]!.data.outputs)).not.toContain(MARK);

    // The JSON trace file and the PDF.
    const exported = await app.inject({ method: 'GET', url: `/api/runs/${runId}/export?format=json&screenshots=none`, headers: as(alice.token) });
    expect(exported.statusCode).toBe(200);
    const trace = JSON.parse(exported.body) as { outputs: { key: string; value: unknown }[]; outputsComplete: boolean };
    expect(trace.outputsComplete).toBe(true);
    expect(trace.outputs.find((o) => o.key === 'account')!.value).toBe('[hidden]');
    expect(JSON.stringify(trace.outputs)).not.toContain(MARK);
    const pdf = await app.inject({ method: 'GET', url: `/api/runs/${runId}/export?format=pdf&screenshots=none`, headers: as(alice.token) });
    expect(pdf.statusCode).toBe(200);

    // MCP: run_status and run_wait carry the outputs, masked; tasks_list carries the definitions.
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/mcp',
        headers: { ...as(alice.token), 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18' },
        payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      return (JSON.parse(res.body) as { result: { content: { text?: string }[]; structuredContent?: Record<string, any>; isError?: boolean } }).result; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    const status = await call('run_status', { run_id: runId });
    expect(status.isError).toBeFalsy();
    expect(status.structuredContent!.outputs.find((o: { key: string }) => o.key === 'account').value).toBe('[hidden]');
    expect(status.structuredContent!.progress.outputs).toHaveLength(4);
    expect(status.structuredContent!.progress.outputs_complete).toBe(true);
    // The model-facing text says so too, and marks it as from the web.
    expect(status.content[0]!.text).toMatch(/untrusted/i);
    const waited = await call('run_wait', { run_id: runId, wait_s: 0 });
    expect(waited.structuredContent!.outputs).toHaveLength(4);
    const tasks = await call('tasks_list', {});
    expect((tasks.structuredContent!.items as { outputs?: { key: string }[] }[]).find((t) => t.outputs)!.outputs!.map((o) => o.key)).toContain('confirmation_number');
    for (const r of [status, waited, tasks]) expect(JSON.stringify(r)).not.toContain(MARK);
  });
});

describe('GET /api/tasks/{id}/outputs', () => {
  it('pages the finished runs newest first, with the columns, and is 404 for another user’s task', async () => {
    const alice = await login(`out-page-${stamp}@example.test`);
    const bob = await login(`out-page-bob-${stamp}@example.test`);
    const { task } = await createTask(alice.token);
    const ids: string[] = [];
    for (let i = 1; i <= 3; i += 1) ids.push(await finishedRun(alice, task!.id, { ...STORED, confirmation_number: { value: `C-${i}`, ok: true } }));
    // A run that is still live is not a row of the history.
    await app.inject({ method: 'POST', url: `/api/tasks/${task!.id}/runs`, headers: as(alice.token), payload: {} });

    const first = await app.inject({ method: 'GET', url: `/api/tasks/${task!.id}/outputs?limit=2`, headers: as(alice.token) });
    expect(first.statusCode).toBe(200);
    const page1 = data<{ columns: { key: string }[]; items: { runId: string; values: Record<string, { value: unknown }> }[]; nextCursor: string | null }>(first);
    expect(page1.columns.map((c) => c.key)).toEqual(['confirmation_number', 'amount_paid', 'paid_on', 'account']);
    expect(page1.items.map((i) => i.runId)).toEqual([ids[2], ids[1]]);
    expect(page1.items[0]!.values.confirmation_number!.value).toBe('C-3');
    expect(page1.items[0]!.values.account!.value).toBe('[hidden]');
    expect(page1.nextCursor).not.toBeNull();
    expect(first.body).not.toContain(MARK);

    const second = data<{ items: { runId: string }[]; nextCursor: string | null }>(await app.inject({ method: 'GET', url: `/api/tasks/${task!.id}/outputs?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`, headers: as(alice.token) }));
    expect(second.items.map((i) => i.runId)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();

    expect((await app.inject({ method: 'GET', url: `/api/tasks/${task!.id}/outputs`, headers: as(bob.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/tasks/${task!.id}/outputs?cursor=nope`, headers: as(alice.token) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/tasks/${task!.id}/outputs` })).statusCode).toBe(401);
  });

  it('adds a column for a key an older run reported that the task no longer has', async () => {
    const alice = await login(`out-cols-${stamp}@example.test`);
    const { task } = await createTask(alice.token);
    await finishedRun(alice, task!.id, STORED);
    await app.inject({ method: 'PATCH', url: `/api/tasks/${task!.id}`, headers: as(alice.token), payload: { outputs: [{ key: 'balance', label: 'Balance', type: 'money' }] } });
    await finishedRun(alice, task!.id, { balance: { value: { amount: 10, currency: null }, ok: true } });
    const page = data<{ columns: { key: string; label: string }[]; items: { values: Record<string, unknown> }[] }>(await app.inject({ method: 'GET', url: `/api/tasks/${task!.id}/outputs`, headers: as(alice.token) }));
    expect(page.columns.map((c) => c.key)).toEqual(['balance', 'confirmation_number', 'amount_paid', 'paid_on', 'account']);
    expect(Object.keys(page.items[0]!.values)).toEqual(['balance']);
    expect(Object.keys(page.items[1]!.values)).toContain('confirmation_number');
  });
});
