// Artifacts across a chat's jobs (E41.4, #701): a follow-up job attaches the previous job's masked final screenshot by `run: "previous"`,
// without a browser; the owner's card names the attachment and where it came from. Only the same owner and the same chat count: a task run,
// another chat and another owner's runs are never reached. Real database, the capability double, invented data.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import type { AiService } from '@marinoscar/platform-api/ai';
import { JobsService } from '@marinoscar/platform-api/jobs';

import { ChatResults } from '../src/chat/chat-results.service';
import { ChatTurnService } from '../src/chat/chat-turn.service';
import { ChatService } from '../src/chat/chat.service';
import { createApp } from '../src/main';
import { TasksService } from '../src/tasks/tasks.service';
import { connectionKit, fakeFabric, login, scriptedModel, type Call, type Kit } from './support/connection-run-kit';

let app: NestFastifyApplication;
let kit: Kit;
const stamp = `${Date.now()}`;

const workerMode = process.env.JOBS_WORKER_MODE;
beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
  kit = connectionKit(app);
});
afterAll(async () => {
  await kit?.cleanup();
  await app?.close();
});

const PICTURE = Buffer.from('masked-final-picture-bytes');
const SEND: Call = ['mail_send', { connection: 'Work', draft_id: null, to: ['trips@example.test'], cc: null, bcc: null, subject: 'Miles', body: 'The balance is 99,667 miles.', reply_to_message_id: null, attachments: [{ source: 'screenshot', step: null, run: 'previous' }] }];
const FINISH: Call = ['finish', { success: true, result: 'Sent.' }];

/** An owner with a chat that lists a Work account, a finished previous job with stored pictures, and a new job of the same chat. */
async function chatWithPrevious(name: string) {
  const userId = await login(app, `artifacts-${name}-${stamp}@example.test`);
  const conn = await kit.connect(userId, 'Work', ['mail_read', 'mail_send']);
  const chat = await kit.prisma.conversation.create({ data: { userId, title: '' } });
  await kit.prisma.conversationConnection.create({ data: { conversationId: chat.id, connectionId: conn.id, access: 'read_write' } });
  const prev = await kit.prisma.run.create({ data: { userId, conversationId: chat.id, goal: 'Find the miles balance', trigger: 'chat', origin: 'web', status: 'succeeded', result: 'Balance: 99,667 miles.', finishedAt: new Date() } });
  await kit.prisma.runStep.createMany({
    data: [
      { runId: prev.id, seq: 2, kind: 'action', action: 'navigate', screenshotKey: `k/${prev.id}/2`, screenshotMoment: 'question', screenshotMasked: 0 },
      { runId: prev.id, seq: 4, kind: 'end', screenshotKey: `k/${prev.id}/4`, screenshotMoment: 'final', screenshotMasked: 1 },
    ],
  });
  const run = await kit.prisma.run.create({ data: { userId, conversationId: chat.id, goal: 'Email the balance with a screenshot', trigger: 'chat', origin: 'web' } });
  return { userId, chat, prev, run, conn };
}

const store = () => {
  const stored = new Map<string, Buffer>();
  return { stored, artifacts: { put: async (k: string, b: Buffer) => void stored.set(k, b), get: async (k: string) => (k.startsWith('k/') ? { bytes: PICTURE, contentType: 'image/png' } : stored.has(k) ? { bytes: stored.get(k)!, contentType: 'image/png' } : null), delete: async (k: string) => void stored.delete(k) } };
};

describe('attaching the previous job\'s picture (E41.4)', () => {
  it('sends the previous job\'s final screen after the owner approves a card that names it, with no browser', async () => {
    const r = await chatWithPrevious('send');
    const fabric = fakeFabric();
    const model = scriptedModel([[SEND], [SEND, FINISH]]);
    const runner = kit.runner(model, fabric);
    runner.artifacts = store().artifacts as never;
    expect(await runner.advance(r.run.id, r.userId, null)).toBe('waiting_human');
    const q = await kit.prisma.question.findFirstOrThrow({ where: { runId: r.run.id, status: 'pending' } });
    expect(JSON.stringify(q.action)).toContain('Screenshot from the previous job (final screen): previous-job-screenshot-step-4.png');
    await kit.answer(r.userId, r.run.id, { outcome: 'completed', value: 'approve' });
    expect(await runner.advance(r.run.id, r.userId, null)).toBe('succeeded');
    const sent = kit.fake.account(r.conn.id).sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.attachments!.map((a) => [a.filename, a.bytes.toString()])).toEqual([['previous-job-screenshot-step-4.png', PICTURE.toString()]]);
    expect(fabric.sessions()).toBe(0);
    // The step keeps where it came from, never the bytes.
    const step = await kit.prisma.runStep.findFirstOrThrow({ where: { runId: r.run.id, action: 'mail_send', ok: true } });
    expect(JSON.stringify(step.args)).toContain('"from":"previous"');
    expect(JSON.stringify(step)).not.toContain(PICTURE.toString());
  });

  it('refuses another chat\'s and another owner\'s runs: only this chat\'s previous job is reachable', async () => {
    const a = await chatWithPrevious('scope-a');
    // A second chat of the same owner, with no finished job: A's pictures are not "previous" for it.
    const otherChat = await kit.prisma.conversation.create({ data: { userId: a.userId, title: '' } });
    await kit.prisma.conversationConnection.create({ data: { conversationId: otherChat.id, connectionId: a.conn.id, access: 'read_write' } });
    const other = await kit.prisma.run.create({ data: { userId: a.userId, conversationId: otherChat.id, goal: 'Email it', trigger: 'chat', origin: 'web' } });
    const m1 = scriptedModel([[SEND, FINISH]]);
    const r1 = kit.runner(m1, fakeFabric());
    r1.artifacts = store().artifacts as never;
    await r1.advance(other.id, a.userId, null);
    expect(m1.outputs[0]).toBe('There is no earlier job in this chat.');

    // Another owner, in a chat id of A's (a run row can only be made for its own owner's chat, so the owner check is what is proven).
    const b = await chatWithPrevious('scope-b');
    await kit.prisma.run.update({ where: { id: b.prev.id }, data: { conversationId: a.chat.id } }).catch(() => undefined);
    const m2 = scriptedModel([[SEND, FINISH]]);
    const r2 = kit.runner(m2, fakeFabric());
    r2.artifacts = store().artifacts as never;
    await r2.advance(b.run.id, b.userId, null);
    // B's chat now has no previous job of its own (it was moved to A's chat id): never A's run.
    expect(m2.outputs[0]).toBe('There is no earlier job in this chat.');
  });

  it('refuses "previous" in a task run, which has no chat', async () => {
    const r = await chatWithPrevious('task');
    const task = await kit.prisma.task.create({ data: { userId: r.userId, name: `t-${stamp}`, goal: 'Email it' } });
    await kit.prisma.taskConnection.create({ data: { taskId: task.id, connectionId: r.conn.id, access: 'read_write' } });
    const run = await kit.prisma.run.create({ data: { userId: r.userId, taskId: task.id, goal: 'Email it' } });
    const model = scriptedModel([[SEND, FINISH]]);
    const runner = kit.runner(model, fakeFabric());
    runner.artifacts = store().artifacts as never;
    await runner.advance(run.id, r.userId, null);
    expect(model.outputs[0]).toBe('This job has no previous job to take that from.');
  });
});

describe('what the next job is told the previous one saved (E41.4)', () => {
  it('lists the final screen, the other step pictures and the report in the follow-up context', async () => {
    const r = await chatWithPrevious('context');
    // The new job is started by the chat this time: the earlier queued row is removed so the previous job is the newest finished one.
    await kit.prisma.run.delete({ where: { id: r.run.id } });
    const chats = app.get(ChatService, { strict: false });
    await chats.postUserMessage(r.userId, r.chat.id, 'Email that to trips@example.test with a screenshot');
    const runTools = async (req: { tools: { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> }[] }) => {
      await req.tools.find((t) => t.tool.name === 'start_run')!.execute({ goal: 'An email to trips@example.test with the balance (99,667 miles) and the previous job\'s screenshot, using the Work account.', expects: 'accounts' }, {});
      return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
    };
    const ai = { forUser: () => ({ runTools }) } as unknown as AiService;
    await new ChatTurnService(kit.prisma, chats, app.get(ChatResults, { strict: false }), app.get(TasksService, { strict: false }), app.get(JobsService, { strict: false }), ai).run(r.chat.id, r.userId, null);
    const run = await kit.prisma.run.findFirstOrThrow({ where: { conversationId: r.chat.id, id: { not: r.prev.id } } });
    // Not run here: removed so no later spec's worker picks its job up.
    await kit.prisma.run.delete({ where: { id: run.id } });
    expect((run.transcript as { context: string }).context).toContain('The previous job saved: a screenshot of its final screen (attach it with run "previous"); screenshot of step 2; a PDF report.');
  });
});
