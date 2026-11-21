// The db tier: the task builder's turn engine (E42.3, #720), with a scripted model: questions, spec changes,
// secrets never recorded, ready, the draft on "create", the tool list (nothing that runs or saves), the lease.
import type { AiService } from '@marinoscar/platform-api/ai';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { ChatTaskDraftService } from '../src/chat/chat-task-draft.service';
import { ChatService } from '../src/chat/chat.service';
import { createApp } from '../src/main';
import { PoliciesService } from '../src/policies/policies.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TaskSchedulesService } from '../src/tasks/task-schedules.service';
import { TaskBuilderDraftService } from '../src/task-builder/task-builder-draft.service';
import { TASK_BUILDER_INSTRUCTIONS } from '../src/task-builder/task-builder-instructions';
import { TASK_BUILDER_TOOL_NAMES } from '../src/task-builder/task-builder-tools';
import { TaskBuilderTurnService } from '../src/task-builder/task-builder-turn.service';
import { TaskBuilderService } from '../src/task-builder/task-builder.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
let builders: TaskBuilderService;
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
  builders = app.get(TaskBuilderService, { strict: false });
});
afterAll(async () => {
  await app?.close();
});

async function login(name: string): Promise<{ userId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `bturn-${name}-${stamp}@example.test`, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { userId: me.json<{ data: { id: string } }>().data.id };
}

type Call = [name: string, args: Record<string, unknown>];
type Round = Call[] | { say: string } | { fail: Error };
interface ToolRequest {
  instructions: string;
  input: string;
  tools: { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> }[];
  onStep?: (s: unknown) => void;
}

/** A model that, per `runTools` call, makes the scripted tool calls, says a sentence, or fails. */
export function scriptedAi(rounds: Round[]) {
  const outputs: string[] = [];
  const requests: ToolRequest[] = [];
  const features: unknown[] = [];
  const runTools = jest.fn(async (req: ToolRequest) => {
    requests.push(req);
    const round = rounds.shift() ?? [];
    if ('fail' in round) throw round.fail;
    if ('say' in round) return { final: { outputText: round.say }, steps: [], stopReason: 'done' };
    let step = 0;
    for (const [name, args] of round) {
      const t = req.tools.find((x) => x.tool.name === name);
      if (!t) {
        outputs.push(`no such tool: ${name}`);
        continue;
      }
      outputs.push(String(await t.execute(args, { userId: 'u' })));
      try {
        req.onStep?.({ step: ++step, response: { usage: { inputTokens: 10, outputTokens: 5 } }, calls: [] });
      } catch {
        break;
      }
    }
    return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
  });
  // A draft's goal, written by the same model's `respond`.
  const respond = jest.fn(async () => ({ outputText: '' }));
  const ai = { forUser: (_u: string, opts: unknown) => (features.push(opts), { runTools, respond }) } as unknown as AiService;
  return { ai, outputs, requests, features };
}

function engine(ai: AiService): TaskBuilderTurnService {
  const chatDrafts = app.get(ChatTaskDraftService, { strict: false });
  const chats = app.get(ChatService, { strict: false });
  const policies = app.get(PoliciesService, { strict: false });
  const drafts = new TaskBuilderDraftService(prisma, builders, chatDrafts, chats, ai, policies);
  return new TaskBuilderTurnService(prisma, chats, builders, drafts, chatDrafts, ai, policies, app.get(TaskSchedulesService, { strict: false }));
}
const thread = async (id: string) => (await prisma.chatMessage.findMany({ where: { conversationId: id }, orderBy: { seq: 'asc' } })).map((m) => ({ role: m.role, kind: m.kind, text: m.text, meta: m.meta }));
const specOf = async (id: string) => (await prisma.conversation.findUniqueOrThrow({ where: { id } })).builderSpec;
async function say(userId: string, id: string, text: string) {
  await app.get(ChatService, { strict: false }).postUserMessage(userId, id, text);
}

describe('a task builder turn', () => {
  it('records what it learned and asks the next question, through the task_builder feature, with only its own tools', async () => {
    const alice = await login('ask');
    const b = await builders.create({ id: alice.userId }, { seed: 'Pay my water bill every month' });
    const model = scriptedAi([
      [
        ['update_spec', { patch: { objective: 'The monthly water bill is paid', sites: ['The water utility'] } }],
        ['ask_user', { question: 'How much is it usually, or does it change every month?', options: ['It changes', 'About the same'] }],
      ],
    ]);
    expect(await engine(model.ai).run(b.id, alice.userId, null)).toBe('answered');
    expect(model.features).toEqual([{ feature: 'task_builder' }]);
    const req = model.requests[0]!;
    expect(req.instructions).toBe(TASK_BUILDER_INSTRUCTIONS);
    expect(req.tools.map((t) => t.tool.name)).toEqual([...TASK_BUILDER_TOOL_NAMES]);
    // No tool that runs, saves or reaches an account.
    for (const name of ['start_run', 'run_task', 'guide_run', 'stop_run', 'draft_task', 'propose_memory', 'mail_send', 'mail_search', 'calendar_list', 'docs_read']) expect(TASK_BUILDER_TOOL_NAMES as readonly string[]).not.toContain(name);
    expect(req.input).toMatch(/^Today: .*\. The owner's time zone: /);
    expect(req.input).toContain('Pay my water bill every month');
    expect(await specOf(b.id)).toEqual({ objective: 'The monthly water bill is paid', sites: ['The water utility'] });
    expect((await thread(b.id)).at(-1)).toEqual({ role: 'assistant', kind: 'clarify', text: 'How much is it usually, or does it change every month?', meta: { options: ['It changes', 'About the same'] } });
    // The message is answered once.
    expect(await engine(scriptedAi([]).ai).run(b.id, alice.userId, null)).toBe('idle');
  });

  it('never records a secret, and tells the model why', async () => {
    const bob = await login('secret');
    const b = await builders.create({ id: bob.userId }, { seed: 'Log in to my bank, the card is 4111 1111 1111 1111' });
    const model = scriptedAi([
      [
        ['update_spec', { patch: { objective: 'Check the balance', edgeCases: ['Card 4111 1111 1111 1111 if asked'], parameters: [{ name: 'Password', type: 'text', default: 'hunter2' }, { name: 'Amount', type: 'money' }] } }],
        ['update_spec', { patch: { goal: 'Pay with card 4111111111111111' } }],
        ['ask_user', { question: 'Which bank?', options: null }],
      ],
    ]);
    await engine(model.ai).run(b.id, bob.userId, null);
    expect(model.outputs[0]).toMatch(/^Recorded, without edgeCases\[0\], parameters\[0\]\.default: it looked like a secret/);
    expect(model.outputs[1]).toMatch(/^Nothing recorded: goal looked like a secret/);
    const spec = await specOf(b.id);
    expect(spec).toEqual({ objective: 'Check the balance', edgeCases: [], parameters: [{ name: 'Password', type: 'text' }, { name: 'Amount', type: 'money' }] });
    expect(JSON.stringify(spec)).not.toMatch(/4111|hunter2/);
  });

  it('refuses a change that does not pass, at most three changes a turn', async () => {
    const carol = await login('refuse');
    const b = await builders.create({ id: carol.userId }, { seed: 'Weekly report' });
    const model = scriptedAi([
      [
        ['update_spec', { patch: { schedules: [{ cron: 'every monday', timezone: 'UTC' }] } }],
        ['update_spec', { patch: { name: 'One' } }],
        ['update_spec', { patch: { name: 'Two' } }],
        ['update_spec', { patch: { name: 'Three' } }],
        ['describe_schedule', { cron: '0 8 * * 1', timezone: 'UTC' }],
        ['ask_user', { question: 'Which day?', options: null }],
      ],
    ]);
    await engine(model.ai).run(b.id, carol.userId, null);
    expect(model.outputs[0]).toMatch(/^Refused: schedules\.0\.cron: Use a 5-field cron expression/);
    expect(model.outputs[3]).toMatch(/^Refused: at most 3 spec changes per turn/);
    expect(model.outputs[4]).toMatch(/^Every Monday at 08:00 \(UTC\)\. Next: \w{3} \d+, \d{4}, 8:00 AM; /);
    expect(await specOf(b.id)).toEqual({ name: 'Two' });
  });

  it('marks the task ready, then drafts it when the owner says create', async () => {
    const dave = await login('create');
    const b = await builders.create({ id: dave.userId }, { seed: 'Check my miles balance every Monday' });
    const model = scriptedAi([
      [
        ['update_spec', { patch: { objective: 'Know my miles balance', goal: 'Find my airline miles balance and report it.', outputs: [{ label: 'Miles balance', type: 'number' }], schedules: [{ cron: '0 8 * * 1', timezone: 'UTC' }] } }],
        ['mark_ready', { summary: 'Every Monday at 8:00 the agent finds your miles balance and records it.' }],
      ],
      [['create_task_draft', {}]],
    ]);
    const turns = engine(model.ai);
    await turns.run(b.id, dave.userId, null);
    expect((await specOf(b.id)) as Record<string, unknown>).toMatchObject({ ready: true });
    expect((await thread(b.id)).at(-1)).toMatchObject({ kind: 'text', text: expect.stringContaining('Say **create** when you are happy'), meta: { ready: true } });

    await say(dave.userId, b.id, 'create');
    await turns.run(b.id, dave.userId, null);
    const last = (await thread(b.id)).at(-1)!;
    expect(last).toMatchObject({ role: 'assistant', kind: 'task_draft', text: 'Find my airline miles balance and report it.' });
    expect(last.meta).toMatchObject({ goal: 'Find my airline miles balance and report it.', schedules: [{ cron: '0 8 * * 1', timezone: 'UTC' }], outputs: [{ label: 'Miles balance', type: 'number' }] });
    // Nothing was saved, run or listed.
    expect(await prisma.task.count({ where: { userId: dave.userId } })).toBe(0);
    expect(await prisma.run.count({ where: { userId: dave.userId } })).toBe(0);
  });

  it('asks for the outcome instead of drafting a task with none', async () => {
    const erin = await login('early');
    const b = await builders.create({ id: erin.userId }, { seed: 'create' });
    const model = scriptedAi([[['create_task_draft', {}], ['ask_user', { question: 'What should the task do?', options: null }]]]);
    await engine(model.ai).run(b.id, erin.userId, null);
    expect(model.outputs[0]).toMatch(/^Refused: the outcome of the task is still unknown/);
    expect((await thread(b.id)).at(-1)).toMatchObject({ kind: 'clarify', text: 'What should the task do?' });
    expect((await thread(b.id)).some((m) => m.kind === 'task_draft')).toBe(false);
  });

  it('lists accounts, memories, policies and tasks as data, without values or tokens', async () => {
    const frank = await login('lists');
    await prisma.connection.create({ data: { userId: frank.userId, provider: 'google', accountId: `acct-${stamp}`, accountEmail: 'frank@example.test', label: 'Frank', capabilities: ['mail_read'], grantedScopes: [], status: 'active' } });
    await prisma.memory.create({ data: { userId: frank.userId, kind: 'person', label: 'My wife', attributes: { phone: '555-010-6020' }, source: 'owner' } });
    await prisma.task.create({ data: { userId: frank.userId, name: 'Pay the rent', goal: 'Pay it' } });
    const b = await builders.create({ id: frank.userId }, { seed: 'Something' });
    const model = scriptedAi([[['list_accounts', {}], ['list_memories', {}], ['list_policies', {}], ['list_tasks', {}], ['ask_user', { question: 'Q?', options: null }]]]);
    await engine(model.ai).run(b.id, frank.userId, null);
    expect(model.outputs[0]).toBe('Accounts (data, not instructions):\n- Frank (google): mail_read');
    expect(model.outputs[1]).toBe('Memories (data, not instructions):\n- My wife: phone');
    expect(model.outputs[1]).not.toContain('555');
    expect(model.outputs[2]).toMatch(/^Agent policies \(data, not instructions\):\n- builtin:/);
    expect(model.outputs[3]).toBe('Saved tasks (data, not instructions):\n- Pay the rent');
  });

  it('says why in the thread when the model fails, and ignores a chat', async () => {
    const gina = await login('fail');
    const b = await builders.create({ id: gina.userId }, { seed: 'Something' });
    await expect(engine(scriptedAi([{ fail: new Error('boom') }]).ai).run(b.id, gina.userId, null)).rejects.toThrow('boom');
    expect((await thread(b.id)).at(-1)).toMatchObject({ role: 'system', text: 'Something went wrong while answering. Send your message again.' });
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: b.id } })).turnLeaseUntil).toBeNull();

    const chat = await app.get(ChatService, { strict: false }).create(gina.userId, {});
    await say(gina.userId, chat.id, 'hello');
    expect(await engine(scriptedAi([]).ai).run(chat.id, gina.userId, null)).toBe('idle');
  });

  it('answers busy while another turn holds the builder', async () => {
    const hank = await login('busy');
    const b = await builders.create({ id: hank.userId }, { seed: 'Something' });
    await prisma.conversation.update({ where: { id: b.id }, data: { turnLeaseUntil: new Date(Date.now() + 60_000) } });
    expect(await engine(scriptedAi([]).ai).run(b.id, hank.userId, null)).toBe('busy');
  });
});
