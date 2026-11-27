// The db tier of the chat's saved tasks (E51.2, #1007): the real ChatTurnService with the task starter, against a migrated and seeded
// database and a scripted model. An owner without a task sees exactly the input of before; with tasks the block is in the input, after
// the memories, and never holds a default's value, a memory's value, a preset or a sensitive value; over 15 tasks list_tasks is offered;
// the setting `chat.useSavedTasks` off removes the block, the tool and the new instruction lines; a task run's chat message names the task.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';
import { JobsService } from '@marinoscar/platform-api/jobs';

import { TASK_BLOCK_HEADER, TASK_INSTRUCTION_LINES } from '../src/chat/chat-task-context';
import { ChatResults } from '../src/chat/chat-results.service';
import { CHAT_INSTRUCTIONS, ChatTurnService } from '../src/chat/chat-turn.service';
import { ChatService } from '../src/chat/chat.service';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { QuestionEvents } from '../src/questions/question-events';
import { TaskRunStarter } from '../src/questions/task-run-starter';
import { TaskSchedulesService } from '../src/tasks/task-schedules.service';
import { TasksService } from '../src/tasks/tasks.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
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
  chats = app.get(ChatService, { strict: false });
});
afterAll(async () => {
  await app?.close();
});

type Session = { token: string; userId: string };
async function login(name: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `chat-tasks-${name}-${stamp}@example.test`, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}

type Call = [name: string, args: Record<string, unknown>];
interface Seen {
  instructions: string;
  input: string;
  names: string[];
  outputs: string[];
}
/** A model that records what it was given and makes the scripted calls of its first round trip. */
function scriptedAi(calls: Call[] = []) {
  const seen: Seen[] = [];
  const runTools = async (req: { instructions: string; input: string; tools: { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> }[]; onStep?: (s: unknown) => void }) => {
    const s: Seen = { instructions: req.instructions, input: req.input, names: req.tools.map((t) => t.tool.name), outputs: [] };
    seen.push(s);
    let step = 0;
    for (const [name, args] of seen.length === 1 ? calls : []) {
      const t = req.tools.find((x) => x.tool.name === name);
      if (!t) {
        s.outputs.push(`(not offered: ${name})`);
        continue;
      }
      s.outputs.push(String(await t.execute(args, {})));
      req.onStep?.({ step: ++step, response: { usage: { inputTokens: 1, outputTokens: 1 } }, calls: [] });
    }
    return { final: { outputText: calls.length ? '' : 'ok' }, steps: [], stopReason: 'done' };
  };
  return { ai: { forUser: () => ({ runTools }) } as unknown as AiService, seen };
}

/** The engine as the app wires it for run_task (the task starter present), with a starter that queues nothing. */
function engine(ai: AiService, withStarter = true) {
  const tasks = app.get(TasksService, { strict: false });
  const starter = new TaskRunStarter(prisma, { enqueue: async () => undefined } as never, new QuestionEvents(), tasks, app.get(TaskSchedulesService, { strict: false }));
  return new ChatTurnService(prisma, chats, app.get(ChatResults, { strict: false }), tasks, app.get(JobsService, { strict: false }), ai, undefined, undefined, undefined, withStarter ? starter : undefined);
}

async function chatWith(s: Session, text: string): Promise<string> {
  const chat = await chats.create(s.userId, {});
  await chats.postUserMessage(s.userId, chat.id, text);
  return chat.id;
}

const sendText = (userId: string, extra: Record<string, unknown> = {}) =>
  prisma.task.create({
    data: {
      userId,
      name: 'Send a text',
      goal: 'Send a text message to {{Recipient}} saying {{Message}}',
      parameters: [
        { key: 'recipient', label: 'Recipient', type: 'text', required: true },
        { key: 'message', label: 'Message', type: 'text', required: true },
      ],
      ...extra,
    },
  });

describe('an owner with no saved task', () => {
  it('gets exactly the input, instructions and tools of before #1007', async () => {
    const alice = await login('none');
    const id = await chatWith(alice, 'Hello there');
    const model = scriptedAi();
    await engine(model.ai).run(id, alice.userId, null);
    // The input as it was before this issue: no header, no blank line, nothing else.
    expect(model.seen[0]!.input).toBe('Conversation, oldest first:\n[user] Hello there\n\nState: no run is live.');
    expect(model.seen[0]!.instructions).toBe(CHAT_INSTRUCTIONS);
    expect(model.seen[0]!.names).not.toContain('list_tasks');
    // And the same as an engine that cannot run tasks at all.
    expect(await engine(scriptedAi().ai).buildInput(alice.userId, id)).toBe(await engine(scriptedAi().ai, false).buildInput(alice.userId, id));
  });
});

describe('an owner with saved tasks', () => {
  it('reads the block in the input and the two new instruction lines, and runs the task that fits as the task\'s run', async () => {
    const alice = await login('fits');
    const task = await sendText(alice.userId, { allowedDomains: ['messages.example.test'], confirmRiskyActions: true });
    const id = await chatWith(alice, 'text Ana that dinner moved to 7');
    const model = scriptedAi([['run_task', { task: 'Send a text', inputs: [{ name: 'Recipient', value: 'Ana' }, { name: 'Message', value: 'Dinner moved to 7' }] }]]);
    await engine(model.ai).run(id, alice.userId, null);
    const [seen] = model.seen;
    expect(seen!.input).toBe(
      [
        TASK_BLOCK_HEADER,
        '- Send a text — values: Recipient (text, required), Message (text, required); does: Send a text message to {{Recipient}} saying {{Message}}',
        '',
        'Conversation, oldest first:',
        '[user] text Ana that dinner moved to 7',
        '',
        'State: no run is live.',
      ].join('\n'),
    );
    for (const line of TASK_INSTRUCTION_LINES) expect(seen!.instructions).toContain(line);
    expect(seen!.instructions).not.toContain('- When the owner asks to run one of their saved tasks');
    expect(seen!.names).not.toContain('list_tasks');
    expect(seen!.outputs).toEqual(['Started. The owner watches it in the chat.']);

    const run = await prisma.run.findFirstOrThrow({ where: { conversationId: id } });
    expect(run).toMatchObject({ taskId: task.id, trigger: 'chat', goal: 'Send a text message to ⟦Ana⟧ saying ⟦Dinner moved to 7⟧' });
    // The run's limits are the task's (set by the owner), not the chat's.
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ allowedDomains: ['messages.example.test'], confirmRiskyActions: true });
    const message = await prisma.chatMessage.findFirstOrThrow({ where: { conversationId: id, kind: 'run' } });
    expect(message).toMatchObject({ runId: run.id, meta: { taskId: task.id, taskName: 'Send a text' } });
  });

  it('never shows a default value, a memory value, a schedule preset or a sensitive value', async () => {
    const bob = await login('values');
    const memory = await prisma.memory.create({ data: { userId: bob.userId, kind: 'person', label: 'My landlord', attributes: { phone: '555-010-7788' }, source: 'owner' } });
    const task = await prisma.task.create({
      data: {
        userId: bob.userId,
        name: 'Pay rent',
        goal: 'Pay {{Amount}} to {{Landlord}} with PIN {{Pin}}',
        parameters: [
          { key: 'amount', label: 'Amount', type: 'money', required: true, default: { value: '1875.25' } },
          { key: 'landlord', label: 'Landlord', type: 'phone', required: true, default: { memory: { id: memory.id, attribute: 'phone' } } },
          { key: 'pin', label: 'Pin', type: 'text', required: true, sensitive: true },
        ],
      },
    });
    await prisma.taskSchedule.create({ data: { userId: bob.userId, taskId: task.id, cron: '0 9 1 * *', inputs: { amount: '2999.99' } } });
    const id = await chatWith(bob, 'pay the rent');
    const model = scriptedAi();
    await engine(model.ai).run(id, bob.userId, null);
    const input = model.seen[0]!.input;
    expect(input).toContain('- Pay rent — values: Amount (money, has a saved value), Landlord (phone, has a saved value), Pin (asked for securely)');
    for (const value of ['1875', '555-010-7788', '5550107788', memory.id, '2999']) expect(input).not.toContain(value);
  });

  it('caps the block at 15 tasks, offers list_tasks, and keeps a named task in the block', async () => {
    const carol = await login('many');
    for (let i = 0; i < 20; i += 1) await prisma.task.create({ data: { userId: carol.userId, name: `Routine job ${i}`, goal: `Do routine job ${i} on site-${i}.example.test` } });
    await prisma.task.create({ data: { userId: carol.userId, name: 'Renew the parking permit', goal: 'Renew my parking permit on city.example.test' } });
    const id = await chatWith(carol, 'please renew the parking permit');
    const model = scriptedAi([['list_tasks', { query: 'routine job 7' }]]);
    await engine(model.ai).run(id, carol.userId, null);
    const [seen] = model.seen;
    const lines = seen!.input.split('\n');
    const block = lines.slice(0, lines.indexOf(''));
    expect(block[0]).toBe(TASK_BLOCK_HEADER);
    expect(block).toHaveLength(16);
    expect(block[1]).toBe('- Renew the parking permit; does: Renew my parking permit on city.example.test');
    expect(seen!.names).toContain('list_tasks');
    const listed = seen!.outputs[0]!.split('\n');
    expect(listed[0]).toBe(TASK_BLOCK_HEADER);
    expect(listed[1]).toBe('- Routine job 7; does: Do routine job 7 on site-7.example.test');
    expect(listed.length).toBeLessThanOrEqual(21);
  });

  it('runs a task by the name the block shows, even when the block cleaned it', async () => {
    const dave = await login('shown');
    const task = await prisma.task.create({ data: { userId: dave.userId, name: 'Water\nthe   plants', goal: 'Water the plants' } });
    const id = await chatWith(dave, 'water the plants');
    const model = scriptedAi([['run_task', { task: 'Water the plants', inputs: null }]]);
    await engine(model.ai).run(id, dave.userId, null);
    expect(model.seen[0]!.input).toContain('- Water the plants\n');
    expect(model.seen[0]!.outputs).toEqual(['Started. The owner watches it in the chat.']);
    expect((await prisma.run.findFirstOrThrow({ where: { conversationId: id } })).taskId).toBe(task.id);
  });
});

describe('the setting chat.useSavedTasks', () => {
  it('is on by default; off, there is no block, no list_tasks and the old instruction line, and a named task still runs', async () => {
    const erin = await login('off');
    const headers = { authorization: `Bearer ${erin.token}` };
    const before = await app.inject({ method: 'GET', url: '/api/user-settings', headers });
    expect(before.statusCode).toBe(200);
    for (let i = 0; i < 17; i += 1) await prisma.task.create({ data: { userId: erin.userId, name: `Job ${i}`, goal: `Do job ${i} on site-${i}.example.test` } });
    const task = await sendText(erin.userId);

    const patched = await app.inject({ method: 'PATCH', url: '/api/user-settings', headers, payload: { chat: { useSavedTasks: false } } });
    expect(patched.statusCode).toBe(200);
    const doc = patched.json<{ data?: { chat?: unknown }; chat?: unknown }>();
    expect(doc.data?.chat ?? doc.chat).toEqual({ useSavedTasks: false });

    const id = await chatWith(erin, 'Run my Send a text task for Ana: dinner moved to 7');
    const model = scriptedAi([['run_task', { task: 'Send a text', inputs: [{ name: 'Recipient', value: 'Ana' }, { name: 'Message', value: 'Dinner moved to 7' }] }]]);
    await engine(model.ai).run(id, erin.userId, null);
    const [seen] = model.seen;
    expect(seen!.input).toBe('Conversation, oldest first:\n[user] Run my Send a text task for Ana: dinner moved to 7\n\nState: no run is live.');
    expect(seen!.input).not.toContain(TASK_BLOCK_HEADER);
    expect(seen!.names).not.toContain('list_tasks');
    expect(seen!.instructions).toBe(CHAT_INSTRUCTIONS);
    expect(seen!.outputs).toEqual(['Started. The owner watches it in the chat.']);
    expect((await prisma.run.findFirstOrThrow({ where: { conversationId: id } })).taskId).toBe(task.id);

    // On again: the block is back.
    expect((await app.inject({ method: 'PATCH', url: '/api/user-settings', headers, payload: { chat: { useSavedTasks: true } } })).statusCode).toBe(200);
    expect(await engine(scriptedAi().ai).buildInput(erin.userId, id)).toContain(TASK_BLOCK_HEADER);
  });
});
