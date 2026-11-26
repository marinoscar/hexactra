// Batch runs (E51.1, #1006) against a real, migrated and seeded database: a saved task run once per row, one run after another,
// every row checked before anything is written, Stop on a run stops the batch, a failure continues or stops it, a step of unknown
// outcome stops it, two end hooks start one next run, a restart carries on, and the chat's review card (nothing starts before Start).
// No job worker runs here: the tests move each run to its end themselves, as the runner would.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';
import { JobsService } from '@marinoscar/platform-api/jobs';
import type { Task } from '@prisma/client';

import { ChatResults } from '../src/chat/chat-results.service';
import { ChatTurnService } from '../src/chat/chat-turn.service';
import { ChatService } from '../src/chat/chat.service';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { TaskRunStarter } from '../src/questions/task-run-starter';
import { recordRequestInChat } from '../src/questions/chat-request-record';
import { RunPauseService } from '../src/tasks/run-pause.service';
import { BATCH_CLAIM_GRACE_MS, RunBatchService, batchCounts, type BatchView } from '../src/tasks/run-batch.service';
import { TasksService } from '../src/tasks/tasks.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
let tasks: TasksService;
let batches: RunBatchService;
let chats: ChatService;
const stamp = `${Date.now()}`;

const workerMode = process.env.JOBS_WORKER_MODE;
beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
  prisma = app.get(PrismaService);
  tasks = app.get(TasksService, { strict: false });
  batches = app.get(RunBatchService, { strict: false });
  chats = app.get(ChatService, { strict: false });
});
afterAll(async () => {
  await app?.close();
});

type Session = { token: string; userId: string };
async function login(name: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `batch-${name}-${stamp}@example.test`, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
async function call<T = unknown>(s: Session, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await app.inject({ method, url: `/api${url}`, headers: { authorization: `Bearer ${s.token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const json = res.json<{ data?: T; code?: string; error?: { code?: string; details?: unknown }; details?: unknown }>();
  return { status: res.statusCode, data: json.data as T, code: json.code ?? json.error?.code, details: (json.details ?? json.error?.details) as { rows?: { row: number; missing?: string[]; rows?: number[] }[] } | undefined };
}

async function textTask(s: Session, extra: Partial<Task> = {}): Promise<Task> {
  return prisma.forUser({ userId: s.userId }).task.create({
    data: {
      userId: s.userId,
      name: `Send a text ${stamp}`,
      goal: 'Text {{Recipient}} this message: {{Message}}',
      parameters: [
        { key: 'recipient', label: 'Recipient', type: 'text', required: true },
        { key: 'message', label: 'Message', type: 'text', required: true },
      ],
      ...(extra as object),
    },
  });
}
const rows = (...names: string[]) => names.map((n) => ({ inputs: { Recipient: n, Message: `Dinner moved to 7, ${n}` } }));
const runsOfBatch = (batchId: string) => prisma.run.findMany({ where: { batchId }, orderBy: { batchSeq: 'asc' } });
async function end(userId: string, runId: string, to: 'succeeded' | 'failed') {
  await tasks.transition(userId, runId, 'running');
  await tasks.transition(userId, runId, to, to === 'succeeded' ? { result: 'Sent.', stopReason: 'finished' } : { error: 'The site did not load.', stopReason: 'error' });
}
const liveRunOf = async (batchId: string) => (await prisma.run.findMany({ where: { batchId, status: { in: ['queued', 'running'] } } }))[0];

describe('POST /api/tasks/{id}/batches', () => {
  it('runs three rows one after another, each with its own inputs and goal, and ends done', async () => {
    const s = await login('three');
    const task = await textTask(s);
    const created = await call<BatchView>(s, 'POST', `/tasks/${task.id}/batches`, { rows: rows('Ana', 'Luis', 'Marta') });
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ status: 'running', total: 3, onFailure: 'continue', taskName: task.name });
    expect(created.data.items.map((i) => i.status)).toEqual(['running', 'pending', 'pending']);
    const id = created.data.id;

    // One run at a time: only row 1 has a run.
    let runs = await runsOfBatch(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ batchId: id, batchSeq: 1, taskId: task.id, status: 'queued', trigger: 'manual', goal: 'Text ⟦Ana⟧ this message: ⟦Dinner moved to 7, Ana⟧' });

    await end(s.userId, runs[0]!.id, 'succeeded');
    runs = await runsOfBatch(id);
    expect(runs.map((r) => [r.batchSeq, r.status])).toEqual([
      [1, 'succeeded'],
      [2, 'queued'],
    ]);
    expect(runs[1]!.goal).toBe('Text ⟦Luis⟧ this message: ⟦Dinner moved to 7, Luis⟧');
    await end(s.userId, runs[1]!.id, 'succeeded');
    runs = await runsOfBatch(id);
    await end(s.userId, runs[2]!.id, 'succeeded');

    const done = await call<BatchView>(s, 'GET', `/batches/${id}`);
    expect(done.data).toMatchObject({ status: 'done', summary: '3 of 3 done', stopReason: null });
    expect(done.data.items.map((i) => [i.seq, i.status, i.result])).toEqual([
      [1, 'succeeded', 'Sent.'],
      [2, 'succeeded', 'Sent.'],
      [3, 'succeeded', 'Sent.'],
    ]);
    expect(done.data.items[0]!.values).toEqual([
      { key: 'recipient', label: 'Recipient', value: 'Ana' },
      { key: 'message', label: 'Message', value: 'Dinner moved to 7, Ana' },
    ]);

    // The runs list filter, and a run carries its batch.
    const listed = await call<{ id: string; batchId: string; batchSeq: number }[]>(s, 'GET', `/runs?batchId=${id}&order=asc`);
    expect(listed.data.map((r) => [r.batchSeq, r.batchId])).toEqual([
      [1, id],
      [2, id],
      [3, id],
    ]);
    const page = await call<{ items: BatchView[] }>(s, 'GET', `/tasks/${task.id}/batches`);
    expect(page.data.items.map((b) => b.id)).toContain(id);
  });

  it('refuses the whole batch for one bad row, naming the row, and writes nothing', async () => {
    const s = await login('bad');
    const task = await textTask(s);
    const before = await prisma.runBatch.count({ where: { userId: s.userId } });
    const unknown = await call(s, 'POST', `/tasks/${task.id}/batches`, { rows: [...rows('Ana'), { inputs: { Recipient: 'Luis', Message: 'x', Colour: 'red' } }] });
    expect([unknown.status, unknown.code]).toEqual([400, 'INVALID_INPUT']);
    expect(unknown.details?.rows?.[0]?.row).toBe(2);
    const missing = await call(s, 'POST', `/tasks/${task.id}/batches`, { rows: [...rows('Ana'), { inputs: { Recipient: 'Luis' } }] });
    expect([missing.status, missing.code]).toEqual([400, 'BATCH_INPUTS_MISSING']);
    expect(missing.details?.rows).toEqual([{ row: 2, missing: ['Message'] }]);
    const dup = await call(s, 'POST', `/tasks/${task.id}/batches`, { rows: rows('Ana', 'Luis', 'Ana') });
    expect([dup.status, dup.code]).toEqual([400, 'BATCH_DUPLICATE_ROW']);
    expect(dup.details?.rows).toEqual([{ row: 3, rows: [1, 3] }]);
    const small = await call(s, 'POST', `/tasks/${task.id}/batches`, { rows: rows('Ana') });
    expect([small.status, small.code]).toEqual([400, 'BATCH_TOO_SMALL']);
    const large = await call(s, 'POST', `/tasks/${task.id}/batches`, { rows: rows(...Array.from({ length: 26 }, (_, i) => `P${i}`)) });
    expect([large.status, large.code]).toEqual([400, 'BATCH_TOO_LARGE']);
    const secretTask = await textTask(s, { name: `Pay ${stamp}`, goal: 'Pay {{Recipient}} with {{Pin}}', parameters: [{ key: 'recipient', label: 'Recipient', type: 'text', required: true }, { key: 'pin', label: 'Pin', type: 'text', required: true, sensitive: true }] as never });
    const sensitive = await call(s, 'POST', `/tasks/${secretTask.id}/batches`, { rows: [{ inputs: { Recipient: 'Ana' } }, { inputs: { Recipient: 'Luis' } }] });
    expect([sensitive.status, sensitive.code]).toEqual([400, 'BATCH_SENSITIVE_PARAMETER']);
    expect(await prisma.runBatch.count({ where: { userId: s.userId } })).toBe(before);
    expect(await prisma.run.count({ where: { userId: s.userId } })).toBe(0);
  });

  it('Stop on run 2 of 5 cancels the batch: rows 3 to 5 are skipped and never get a run', async () => {
    const s = await login('stop');
    const task = await textTask(s);
    const { data } = await call<BatchView>(s, 'POST', `/tasks/${task.id}/batches`, { rows: rows('A1', 'A2', 'A3', 'A4', 'A5') });
    await end(s.userId, (await liveRunOf(data.id))!.id, 'succeeded');
    const second = (await liveRunOf(data.id))!;
    expect(second.batchSeq).toBe(2);
    // The owner's Stop on the run itself (the run page, the CLI, a notification all call it).
    expect((await call(s, 'POST', `/runs/${second.id}/cancel`)).status).toBe(200);
    const after = (await call<BatchView>(s, 'GET', `/batches/${data.id}`)).data;
    expect(after).toMatchObject({ status: 'cancelled', stopReason: 'owner_stopped', stoppedAtSeq: 2, summary: '1 done, 1 stopped, 3 not started' });
    expect(after.items.map((i) => i.status)).toEqual(['succeeded', 'cancelled', 'skipped', 'skipped', 'skipped']);
    expect(await prisma.run.count({ where: { batchId: data.id } })).toBe(2);
  });

  it('a failed run leaves the batch running by default, and stops it with onFailure: stop', async () => {
    const s = await login('fail');
    const task = await textTask(s);
    const goOn = (await call<BatchView>(s, 'POST', `/tasks/${task.id}/batches`, { rows: rows('B1', 'B2') })).data;
    await end(s.userId, (await liveRunOf(goOn.id))!.id, 'failed');
    expect((await liveRunOf(goOn.id))!.batchSeq).toBe(2);
    await end(s.userId, (await liveRunOf(goOn.id))!.id, 'succeeded');
    expect((await batches.get(s.userId, goOn.id))).toMatchObject({ status: 'done', summary: '1 done, 1 failed' });

    const stop = (await call<BatchView>(s, 'POST', `/tasks/${task.id}/batches`, { rows: rows('C1', 'C2', 'C3'), onFailure: 'stop' })).data;
    await end(s.userId, (await liveRunOf(stop.id))!.id, 'failed');
    expect(await batches.get(s.userId, stop.id)).toMatchObject({ status: 'cancelled', stopReason: 'row_failed', stoppedAtSeq: 1, summary: '1 failed, 2 not started' });
    expect(await prisma.run.count({ where: { batchId: stop.id } })).toBe(1);
  });

  it('a run that ended with a commit step of unknown outcome stops the batch and names the row', async () => {
    const s = await login('unknown');
    const task = await textTask(s);
    const b = (await call<BatchView>(s, 'POST', `/tasks/${task.id}/batches`, { rows: rows('D1', 'D2', 'D3') })).data;
    await end(s.userId, (await liveRunOf(b.id))!.id, 'succeeded');
    const second = (await liveRunOf(b.id))!;
    await tasks.transition(s.userId, second.id, 'running');
    await prisma.runStep.create({ data: { runId: second.id, seq: 1, kind: 'action', action: 'click', ok: true, summary: "pressed 'Send'", durationMs: 1, phase: 'unknown' } });
    await tasks.transition(s.userId, second.id, 'succeeded', { result: 'Maybe sent.', stopReason: 'finished' });
    const after = await batches.get(s.userId, b.id);
    expect(after).toMatchObject({ status: 'cancelled', stopReason: 'unknown_outcome', stoppedAtSeq: 2 });
    expect(after.items.map((i) => i.status)).toEqual(['succeeded', 'succeeded', 'skipped']);
    expect(await prisma.run.count({ where: { batchId: b.id } })).toBe(2);
  });

  it('two end hooks for the same run start one next run', async () => {
    const s = await login('race');
    const task = await textTask(s);
    const b = (await call<BatchView>(s, 'POST', `/tasks/${task.id}/batches`, { rows: rows('E1', 'E2', 'E3') })).data;
    const first = (await liveRunOf(b.id))!;
    // Ended without the hooks (as a second process would see it), then two hooks at once.
    await prisma.run.update({ where: { id: first.id }, data: { status: 'succeeded', finishedAt: new Date() } });
    await Promise.all([batches.onRunEnd(s.userId, first.id), batches.onRunEnd(s.userId, first.id), batches.onRunEnd(s.userId, first.id)]);
    const runs = await runsOfBatch(b.id);
    expect(runs.map((r) => r.batchSeq)).toEqual([1, 2]);
  });

  it('a second live batch of the same task is 409 BATCH_LIVE', async () => {
    const s = await login('live');
    const task = await textTask(s);
    expect((await call(s, 'POST', `/tasks/${task.id}/batches`, { rows: rows('F1', 'F2') })).status).toBe(201);
    const again = await call(s, 'POST', `/tasks/${task.id}/batches`, { rows: rows('G1', 'G2') });
    expect([again.status, again.code]).toEqual([409, 'BATCH_LIVE']);
  });

  it('carries on after a restart: a run that ended without its hook, and a row claimed whose run was never created', async () => {
    const s = await login('restart');
    const task = await textTask(s);
    const b = (await call<BatchView>(s, 'POST', `/tasks/${task.id}/batches`, { rows: rows('H1', 'H2', 'H3') })).data;
    // The API died after row 1 ended but before its hook ran.
    await prisma.run.update({ where: { id: (await liveRunOf(b.id))!.id }, data: { status: 'succeeded', finishedAt: new Date() } });
    await batches.reconcile();
    expect((await runsOfBatch(b.id)).map((r) => [r.batchSeq, r.status])).toEqual([
      [1, 'succeeded'],
      [2, 'queued'],
    ]);
    // Row 3 claimed, then the API died before its run was created: after the grace it goes back to pending and starts once.
    await prisma.run.update({ where: { id: (await liveRunOf(b.id))!.id }, data: { status: 'succeeded', finishedAt: new Date() } });
    await prisma.runBatchItem.updateMany({ where: { batchId: b.id, seq: 2 }, data: { status: 'succeeded' } });
    await prisma.runBatchItem.updateMany({ where: { batchId: b.id, seq: 3 }, data: { status: 'running', startedAt: new Date(Date.now() - 1000) } });
    await batches.reconcile();
    expect(await prisma.run.count({ where: { batchId: b.id } })).toBe(2); // within the grace: nothing restarted
    await batches.reconcile(new Date(Date.now() + BATCH_CLAIM_GRACE_MS + 5000));
    const runs = await runsOfBatch(b.id);
    expect(runs.map((r) => r.batchSeq)).toEqual([1, 2, 3]);
  });
});

describe('batchCounts', () => {
  it('summarises the rows', () => {
    expect(batchCounts([{ status: 'succeeded' }, { status: 'succeeded' }]).summary).toBe('2 of 2 done');
    expect(batchCounts([{ status: 'succeeded' }, { status: 'succeeded' }, { status: 'failed' }, { status: 'skipped' }, { status: 'pending' }]).summary).toBe('2 done, 1 failed, 2 not started');
  });
});

describe('in a chat: run_task_batch', () => {
  type Call = [name: string, args: Record<string, unknown>];
  function scriptedAi(rounds: Call[][]) {
    const outputs: string[] = [];
    const inputs: string[] = [];
    const tools: string[][] = [];
    const runTools = jest.fn(async (req: { input: string; tools: { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> }[]; onStep?: (s: unknown) => void }) => {
      inputs.push(req.input);
      tools.push(req.tools.map((t) => t.tool.name));
      let step = 0;
      for (const [name, args] of rounds.shift() ?? []) {
        const t = req.tools.find((x) => x.tool.name === name)!;
        outputs.push(String(await t.execute(args, { userId: 'u' })));
        req.onStep?.({ step: ++step, response: { usage: { inputTokens: 1, outputTokens: 1 } }, calls: [] });
      }
      return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
    });
    return { ai: { forUser: () => ({ runTools }) } as unknown as AiService, outputs, inputs, tools };
  }
  const engine = (ai: AiService) =>
    new ChatTurnService(prisma, chats, app.get(ChatResults, { strict: false }), tasks, app.get(JobsService, { strict: false }), ai, undefined, undefined, undefined, app.get(TaskRunStarter, { strict: false }), app.get(RunPauseService, { strict: false }), undefined, undefined, undefined, batches);
  const threeRows = [
    { inputs: [{ name: 'Recipient', value: 'Ana' }, { name: 'Message', value: 'Hi Ana, dinner moved to 7.' }] },
    { inputs: [{ name: 'Recipient', value: 'Luis' }, { name: 'Message', value: 'Luis, dinner is at 7 now.' }] },
    { inputs: [{ name: 'Recipient', value: 'Marta' }, { name: 'Message', value: 'Marta! Dinner moved to 7.' }] },
  ];
  async function say(s: Session, chatId: string, text: string, model: ReturnType<typeof scriptedAi>) {
    await chats.postUserMessage(s.userId, chatId, text);
    await engine(model.ai).run(chatId, s.userId, null);
  }

  it('text three people: a review card, nothing before Start, unticked rows skipped, one summary and no per-run result', async () => {
    const s = await login('chat');
    const task = await textTask(s);
    const chat = await chats.create(s.userId, {});
    const model = scriptedAi([[['run_task_batch', { task: task.name, rows: threeRows }]]]);
    await say(s, chat.id, 'Text Ana, Luis and Marta that dinner moved to 7, each in a personal tone', model);
    expect(model.tools[0]).toContain('run_task_batch');
    expect(model.outputs).toEqual(['Waiting for the owner to review 3 rows.']);
    const card = await prisma.chatMessage.findFirstOrThrow({ where: { conversationId: chat.id, kind: 'batch' } });
    const batchId = (card.meta as { batchId: string }).batchId;
    expect(await batches.get(s.userId, batchId)).toMatchObject({ status: 'review', conversationId: chat.id, trigger: 'chat' });
    expect(await prisma.run.count({ where: { conversationId: chat.id } })).toBe(0);

    // While it waits for review the chat is live: no other job, and no second batch.
    const busy = scriptedAi([[['start_run', { goal: 'Something else', expects: null }], ['run_task', { task: task.name, inputs: null }], ['run_task_batch', { task: task.name, rows: threeRows }]]]);
    await say(s, chat.id, 'Also do something else', busy);
    expect(busy.outputs[0]).toMatch(/^Refused: a batch of this chat is waiting for the owner/);
    expect(busy.inputs[0]).toContain('State: a batch of 3 runs of this chat is waiting for the owner to review it.');

    // The owner unticks Luis and presses Start (the card's call).
    const started = await call<BatchView>(s, 'POST', `/batches/${batchId}/start`, { rows: [1, 3] });
    expect(started.status).toBe(200);
    expect(started.data.items.map((i) => i.status)).toEqual(['running', 'skipped', 'pending']);
    // Row 1's run asks to confirm the send: the request is a card in the thread, as for any chat run.
    const first = (await liveRunOf(batchId))!;
    const question = await prisma.question.create({ data: { ownerUserId: s.userId, askedBy: `run:${first.id}`, runId: first.id, input: 'confirm', kind: 'confirmation', prompt: 'Send the text to Ana?', expiresAt: new Date(Date.now() + 600_000) } });
    await recordRequestInChat(prisma, question);
    expect(await prisma.chatMessage.count({ where: { conversationId: chat.id, kind: 'request' } })).toBe(1);
    await end(s.userId, first.id, 'succeeded');
    const third = (await liveRunOf(batchId))!;
    expect([third.batchSeq, third.trigger, third.conversationId]).toEqual([3, 'chat', chat.id]);
    // A batch run is still a chat run: start_run is refused while it is live.
    const meanwhile = scriptedAi([[['start_run', { goal: 'Another job', expects: null }]]]);
    await say(s, chat.id, 'And book a table', meanwhile);
    expect(meanwhile.outputs[0]).toMatch(/^Refused: a batch of this chat is still running/);
    // Row 3's send went ahead on a saved approval (the gate records the use): the summary says so.
    const rule = await prisma.approvalRule.create({ data: { userId: s.userId, kind: 'gate', host: 'messages.google.com', category: 'send', matchKey: 'send', summary: 'Send texts on messages.google.com' } });
    await prisma.approvalRuleUse.create({ data: { ruleId: rule.id, runId: third.id, stepSeq: 1 } });
    await end(s.userId, third.id, 'succeeded');

    const results = await prisma.chatMessage.findMany({ where: { conversationId: chat.id, kind: 'result' } });
    expect(results).toHaveLength(1);
    expect(results[0]!.text).toBe('2 done, 1 not started\nRow 3: 1 step went ahead on a saved approval: Send texts on messages.google.com.');
    expect(results[0]!.meta).toMatchObject({ batchId, batchSummary: true, status: 'done' });
    // The backstop that writes missed results writes none for a batch's runs.
    await app.get(ChatResults, { strict: false }).sync(s.userId, chat.id);
    expect(await prisma.chatMessage.count({ where: { conversationId: chat.id, kind: 'result' } })).toBe(1);
  });

  it('Cancel in review starts none; stop_run cancels a running batch', async () => {
    const s = await login('chat-cancel');
    const task = await textTask(s);
    const chat = await chats.create(s.userId, {});
    await say(s, chat.id, 'Text them all', scriptedAi([[['run_task_batch', { task: task.name, rows: threeRows }]]]));
    const first = (await prisma.runBatch.findFirstOrThrow({ where: { conversationId: chat.id } })).id;
    const cancelled = await call<BatchView>(s, 'POST', `/batches/${first}/cancel`);
    expect(cancelled.data).toMatchObject({ status: 'cancelled', stopReason: 'owner_stopped', summary: '3 not started' });
    expect(await prisma.run.count({ where: { conversationId: chat.id } })).toBe(0);
    expect((await call(s, 'POST', `/batches/${first}/start`, {})).code).toBe('BATCH_NOT_IN_REVIEW');

    await say(s, chat.id, 'Try again', scriptedAi([[['run_task_batch', { task: task.name, rows: threeRows }]]]));
    const second = (await prisma.runBatch.findFirstOrThrow({ where: { conversationId: chat.id, status: 'review' } })).id;
    await call(s, 'POST', `/batches/${second}/start`, {});
    const stop = scriptedAi([[['stop_run', {}]]]);
    await say(s, chat.id, 'Stop', stop);
    expect(stop.outputs[0]).toBe('Stopping the batch: its current run and the rows that have not started.');
    expect(await batches.get(s.userId, second)).toMatchObject({ status: 'cancelled', stopReason: 'owner_stopped' });
    expect((await runsOfBatch(second)).map((r) => r.status)).toEqual(['cancelled']);
  });

  it('a bad row is answered to the model as a sentence naming the row', async () => {
    const s = await login('chat-bad');
    const task = await textTask(s);
    const chat = await chats.create(s.userId, {});
    const model = scriptedAi([[['run_task_batch', { task: task.name, rows: [threeRows[0], { inputs: [{ name: 'Recipient', value: 'Luis' }] }] }]]]);
    await say(s, chat.id, 'Text Ana and Luis', model);
    expect(model.outputs[0]).toBe('Refused: Row 2 needs Message. Ask the owner once for what is missing, then call run_task_batch again with every row.');
    expect(await prisma.runBatch.count({ where: { conversationId: chat.id } })).toBe(0);
  });
});
