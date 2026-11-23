// The db tier: saving a chat as a task (#489) against a real, migrated and
// seeded database: the draft the AI writes, what it falls back to, what it is
// shown, the `draft_task` tool, and the line that links the saved task.
import { suggestedConnections } from '../src/tasks/run-suggestions';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';
import { JobsService } from '@marinoscar/platform-api/jobs';

import { ChatResults } from '../src/chat/chat-results.service';
import { ChatTaskDraftService, TASK_DRAFT_INSTRUCTIONS, draftDefinitions, parseDraft } from '../src/chat/chat-task-draft.service';
import { ChatTurnService } from '../src/chat/chat-turn.service';
import { ChatService } from '../src/chat/chat.service';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
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
async function login(name: string, role: 'contributor' | 'viewer' = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `draft-${name}-${stamp}@example.test`, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
async function post<T = unknown>(s: Session, url: string, payload: unknown = {}): Promise<{ statusCode: number; code?: string; data: T }> {
  const res = await app.inject({ method: 'POST', url: `/api${url}`, headers: { authorization: `Bearer ${s.token}` }, payload: payload as object });
  const body = res.json<{ data?: T; code?: string; error?: { code?: string } }>();
  return { statusCode: res.statusCode, code: body.code ?? body.error?.code, data: body.data as T };
}

/** A model whose `respond` answers the given text (or fails), remembering what it was asked. */
function writer(answer: string | Error) {
  const asked: { instructions: string; input: string }[] = [];
  const respond = jest.fn(async (req: { instructions: string; input: string }) => {
    asked.push(req);
    if (answer instanceof Error) throw answer;
    return { outputText: answer };
  });
  const features: unknown[] = [];
  const ai = { forUser: (_userId: string, opts: unknown) => (features.push(opts), { respond }) } as unknown as AiService;
  return { ai, asked, features, respond };
}

/** A chat in which a job was clarified, run and finished, with its own run settings. */
async function finishedChat(s: Session) {
  const chat = await chats.create(s.userId, { title: 'Cinema', profile: 'home', hostFallback: false, policyId: 'builtin:economy', allowedDomains: ['cinema.example.test'], confirmRiskyActions: true });
  await chats.postUserMessage(s.userId, chat.id, 'Book cinema tickets for tonight');
  await chats.append(chat.id, { role: 'assistant', kind: 'clarify', text: 'Which showing?', meta: { options: ['4:30 PM', '7:30 PM'] } });
  await chats.postUserMessage(s.userId, chat.id, '7:30 PM, two seats in the middle');
  const run = await prisma.run.create({ data: { userId: s.userId, conversationId: chat.id, trigger: 'chat', goal: 'Book 2 tickets for the 7:30 PM showing tonight, middle rows.', status: 'succeeded', result: 'Booked F7 and F8.' } });
  await chats.append(chat.id, { role: 'assistant', kind: 'run', text: run.goal, runId: run.id });
  await chats.append(chat.id, { role: 'assistant', kind: 'result', text: 'Booked F7 and F8.', runId: run.id, meta: { status: 'succeeded' } });
  return { chat, run };
}

describe('the task draft the AI writes', () => {
  it('proposes outputs from what the finished run reported, keys derived, none sensitive (E39.5)', async () => {
    const alice = await login('outputs');
    const { chat } = await finishedChat(alice);
    const model = writer('{"name": "Cinema", "goal": "Book 2 tickets for tonight.", "outputs": [{"label": "Booking reference", "type": "text", "help": "On the confirmation page"}, {"label": "Total paid", "type": "money"}, {"label": "Total paid", "type": "text"}]}');
    const draft = await new ChatTaskDraftService(prisma, model.ai).draft(alice.userId, chat.id, 'org-1');
    expect(draft.outputs).toEqual([
      { key: 'booking_reference', label: 'Booking reference', type: 'text', required: true, help: 'On the confirmation page' },
      { key: 'total_paid', label: 'Total paid', type: 'money', required: true },
    ]);
    expect(model.asked[0]!.instructions).toContain('Outputs:');
  });

  it('takes its name and goal from the model and everything else from the chat', async () => {
    const alice = await login('write');
    const { chat } = await finishedChat(alice);
    const model = writer('{"name": "Cinema tickets for tonight", "goal": "Book 2 tickets for the 7:30 PM showing of tonight\'s film at the usual cinema, in the middle rows."}');
    const draft = await new ChatTaskDraftService(prisma, model.ai).draft(alice.userId, chat.id, 'org-1');

    expect(draft).toEqual({
      name: 'Cinema tickets for tonight',
      goal: "Book 2 tickets for the 7:30 PM showing of tonight's film at the usual cinema, in the middle rows.",
      profile: 'home',
      hostId: null,
      hostFallback: false,
      policyId: 'builtin:economy',
      allowedDomains: ['cinema.example.test'],
      confirmRiskyActions: true,
      useSavedLogins: false,
      useSavedIdentity: false,
      useSavedCards: false,
      recordVideo: false,
      // Nothing in it varies between runs: no parameters.
      parameters: [],
      outputs: [],
      // The chat lists no account: none proposed (E41.5).
      connections: [],
    });
    expect(model.features).toEqual([{ feature: 'chat_orchestrator', orgId: 'org-1' }]);
    expect(model.asked[0]!.instructions).toBe(TASK_DRAFT_INSTRUCTIONS);
    expect(model.asked[0]!.instructions).toMatch(/Never include a password, a code, a card number/);
    // It read the conversation: the request, the clarification, the answer, the run and its result.
    for (const line of ['[user] Book cinema tickets for tonight', '[assistant asked] Which showing?', '[user] 7:30 PM, two seats in the middle', '[run started] Book 2 tickets', '[run succeeded] Booked F7 and F8.']) {
      expect(model.asked[0]!.input).toContain(line);
    }
    // Nothing was saved.
    expect(await prisma.task.count({ where: { userId: alice.userId } })).toBe(0);
  });

  it("is shown chat messages only: never a question's answer", async () => {
    const alice = await login('secret');
    const { chat, run } = await finishedChat(alice);
    await prisma.question.create({
      data: { ownerUserId: alice.userId, askedBy: `run:${run.id}`, runId: run.id, input: 'text', kind: 'code', prompt: 'Enter the code from your phone', status: 'answered', response: { outcome: 'completed', value: '918273', valueWithheld: false }, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    const model = writer('{"name":"n","goal":"g"}');
    await new ChatTaskDraftService(prisma, model.ai).draft(alice.userId, chat.id, null);
    expect(model.asked[0]!.input).not.toContain('918273');
    expect(model.asked[0]!.input).not.toContain('Enter the code');
  });

  it.each([
    ['the model fails', new Error('provider_unavailable')],
    ['the model answers prose', 'Sure! Here is your task.'],
    ['the model answers JSON without a goal', '{"name": "x"}'],
  ])("falls back to the newest run's goal and the chat's title when %s", async (_name, answer) => {
    const alice = await login(`fallback-${String(answer).length}`);
    const { chat } = await finishedChat(alice);
    const draft = await new ChatTaskDraftService(prisma, writer(answer).ai).draft(alice.userId, chat.id, null);
    expect(draft).toMatchObject({ name: 'Cinema', goal: 'Book 2 tickets for the 7:30 PM showing tonight, middle rows.', profile: 'home' });
  });

  it('falls back to the first message when the chat started no run, and clips a long answer', async () => {
    const alice = await login('norun');
    const chat = await chats.create(alice.userId, {});
    await chats.postUserMessage(alice.userId, chat.id, 'Check my electricity bill');
    const drafts = new ChatTaskDraftService(prisma, writer(new Error('no model')).ai);
    expect(await drafts.draft(alice.userId, chat.id, null)).toMatchObject({ name: 'Check my electricity bill', goal: 'Check my electricity bill', policyId: null, allowedDomains: [] });

    const long = await new ChatTaskDraftService(prisma, writer(JSON.stringify({ name: 'n'.repeat(500), goal: 'g'.repeat(9000) })).ai).draft(alice.userId, chat.id, null);
    expect(long.name).toHaveLength(200);
    expect(long.goal).toHaveLength(4000);
  });

  it('the Zelle chat drafts three placeholders: the amount asked each time, the phone and the account defaulted (#556)', async () => {
    const alice = await login('zelle');
    const chat = await chats.create(alice.userId, { title: 'Zelle', confirmRiskyActions: true });
    await chats.postUserMessage(alice.userId, chat.id, 'Send my wife $10 with Zelle from my Bank of America checking');
    await chats.append(chat.id, { role: 'assistant', kind: 'clarify', text: 'Which phone does she use for Zelle, and which checking account?' });
    await chats.postUserMessage(alice.userId, chat.id, '555-010-6020, the checking ending in 0659');
    const run = await prisma.run.create({ data: { userId: alice.userId, conversationId: chat.id, trigger: 'chat', goal: 'Send $10 today to 555-010-6020 using Zelle on my Bank of America account, checking ending in 0659', status: 'succeeded', result: 'Sent.' } });
    await chats.append(chat.id, { role: 'assistant', kind: 'result', text: 'Sent.', runId: run.id, meta: { status: 'succeeded' } });
    const goal = 'Send {{Amount}} today to {{Recipient phone}} using Zelle on my Bank of America account using the checking account ending in {{Account last 4}}';
    const model = writer(
      JSON.stringify({
        name: 'Zelle to my wife',
        goal,
        parameters: [
          { name: 'Amount', type: 'money' },
          { name: 'Recipient phone', type: 'phone', default: '555-010-6020', memory: 'My wife', attribute: 'phone' },
          { name: 'Account last 4', type: 'text', default: '0659' },
        ],
      }),
    );
    const draft = await new ChatTaskDraftService(prisma, model.ai).draft(alice.userId, chat.id, null);
    expect(draft.goal).toBe(goal);
    // No memory of that label exists for this owner, so the phone keeps the fixed value from the conversation.
    expect(draft.parameters).toEqual([
      { key: 'amount', label: 'Amount', type: 'money', required: true },
      { key: 'recipient_phone', label: 'Recipient phone', type: 'phone', required: true, default: { value: '555-010-6020' } },
      { key: 'account_last_4', label: 'Account last 4', type: 'text', required: true, default: { value: '0659' } },
    ]);
    expect(model.asked[0]!.instructions).toMatch(/becomes a placeholder \{\{Name\}\}/);
    // The draft saved nothing: the owner reviews it in the task form.
    expect(await prisma.task.count({ where: { userId: alice.userId } })).toBe(0);
  });

  it("defaults a person's phone from the owner's own memory, read from the memories table, and never shows the model its values (#556)", async () => {
    const alice = await login('zelle-memory');
    const bob = await login('zelle-memory-other');
    const wife = await prisma.memory.create({ data: { userId: alice.userId, kind: 'person', label: 'My wife', aliases: ['wife'], attributes: { name: 'Person A', phone: '555-010-6020' }, source: 'owner' } });
    // Archived and other people's memories are never offered.
    await prisma.memory.create({ data: { userId: alice.userId, kind: 'person', label: 'Old contact', attributes: { phone: '555-010-1111' }, source: 'owner', status: 'archived' } });
    await prisma.memory.create({ data: { userId: bob.userId, kind: 'person', label: 'Bob only', attributes: { phone: '555-010-2222' }, source: 'owner' } });
    const chat = await chats.create(alice.userId, { title: 'Zelle' });
    await chats.postUserMessage(alice.userId, chat.id, 'Send my wife $10 with Zelle');
    const goal = 'Send {{Amount}} today to {{Recipient phone}} using Zelle';
    const model = writer(
      JSON.stringify({
        name: 'Zelle to my wife',
        goal,
        parameters: [
          { name: 'Amount', type: 'money' },
          // Named by an alias: matched like the label.
          { name: 'Recipient phone', type: 'phone', default: '555-010-6020', memory: 'wife', attribute: 'phone' },
        ],
      }),
    );
    const draft = await new ChatTaskDraftService(prisma, model.ai).draft(alice.userId, chat.id, null);
    expect(draft.parameters).toEqual([
      { key: 'amount', label: 'Amount', type: 'money', required: true },
      { key: 'recipient_phone', label: 'Recipient phone', type: 'phone', required: true, default: { memory: { id: wife.id, attribute: 'phone' } } },
    ]);
    const input = model.asked[0]!.input;
    expect(input).toContain('- My wife: name, phone');
    expect(input).not.toContain('Old contact');
    expect(input).not.toContain('Bob only');
    // Labels and value names only: never a value.
    expect(input).not.toContain('555-010-6020');
    expect(input).not.toContain('Person A');

    // Saved as drafted, the task's run resolves the phone from the memory: only the amount is missing.
    const saved = await post<{ id: string; parameters: unknown[] }>(alice, '/tasks', { name: draft.name, goal: draft.goal, parameters: draft.parameters, confirmRiskyActions: true });
    expect(saved.statusCode).toBe(201);
    expect(saved.data.parameters).toEqual(draft.parameters);
  });

  it('a draft whose parameters do not pass the checks keeps the placeholders, then none (#556)', async () => {
    const alice = await login('badparams');
    const { chat } = await finishedChat(alice);
    // A default that is no amount: the placeholder stays, asked every time.
    const bad = await new ChatTaskDraftService(prisma, writer(JSON.stringify({ name: 'n', goal: 'Pay {{Amount}}', parameters: [{ name: 'Amount', type: 'money', default: 'ten dollars' }] })).ai).draft(alice.userId, chat.id, null);
    expect(bad.parameters).toEqual([{ key: 'amount', label: 'Amount', type: 'money', required: true }]);
    // A malformed goal: no parameters; the owner sees the problem in the form.
    const broken = await new ChatTaskDraftService(prisma, writer(JSON.stringify({ name: 'n', goal: 'Pay {{Amount', parameters: [{ name: 'Amount', type: 'money' }] })).ai).draft(alice.userId, chat.id, null);
    expect(broken.parameters).toEqual([]);
  });

  it('a memory default needs a memory of that label holding that value (#556)', () => {
    const memories = [{ id: '88888888-8888-4888-8888-888888888888', label: 'My wife', attributes: ['name', 'phone'] }];
    const goal = 'Call {{Phone}} and {{Email}}';
    expect(
      draftDefinitions(goal, [
        { name: 'Phone', type: 'phone', memory: 'my wife', attribute: 'Phone' },
        { name: 'Email', type: 'email', memory: 'My wife', attribute: 'email', default: 'a@example.test' },
      ], memories),
    ).toEqual([
      { key: 'phone', label: 'Phone', type: 'phone', required: true, default: { memory: { id: memories[0]!.id, attribute: 'phone' } } },
      { key: 'email', label: 'Email', type: 'email', required: true, default: { value: 'a@example.test' } },
    ]);
  });

  it('reads the JSON out of an answer with a code fence or words around it', () => {
    expect(parseDraft('```json\n{"name":"A","goal":"Do it"}\n```')).toEqual({ name: 'A', goal: 'Do it' });
    expect(parseDraft('Here: {"goal":" Do it "} done')).toEqual({ name: '', goal: 'Do it' });
    expect(parseDraft('{"goal":""}')).toBeNull();
    expect(parseDraft('{not json}')).toBeNull();
    expect(parseDraft('nothing')).toBeNull();
    expect(parseDraft('{"goal":"Pay {{Amount}}","parameters":[{"name":"Amount","type":"money"},{"name":"","type":"text"},{"name":"X","type":"weird"}]}')).toEqual({
      name: '',
      goal: 'Pay {{Amount}}',
      parameters: [
        { name: 'Amount', type: 'money' },
        { name: 'X', type: 'text' },
      ],
    });
  });
});

describe('POST /chats/:id/task-draft', () => {
  it('answers a draft (here with no model set up: the fallback) and saves nothing', async () => {
    const alice = await login('route');
    const { chat } = await finishedChat(alice);
    const res = await post<{ name: string; goal: string; policyId: string | null }>(alice, `/chats/${chat.id}/task-draft`);
    expect(res.statusCode).toBe(200);
    expect(res.data).toMatchObject({ name: 'Cinema', goal: 'Book 2 tickets for the 7:30 PM showing tonight, middle rows.', policyId: 'builtin:economy' });
    expect(await prisma.task.count({ where: { userId: alice.userId } })).toBe(0);
  });

  it("answers 404 for another user's chat and 403 without tasks:write", async () => {
    const alice = await login('owner');
    const mallory = await login('other');
    const viewer = await login('viewer', 'viewer');
    const { chat } = await finishedChat(alice);
    const foreign = await post(mallory, `/chats/${chat.id}/task-draft`);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.code).toBe('CHAT_NOT_FOUND');
    const own = await prisma.conversation.create({ data: { userId: viewer.userId, title: 'Read only' } });
    expect((await post(viewer, `/chats/${own.id}/task-draft`)).statusCode).toBe(403);
  });
});

describe('the draft_task tool', () => {
  it('writes a task_draft message carrying the draft, and ends the turn', async () => {
    const alice = await login('tool');
    const { chat } = await finishedChat(alice);
    await chats.postUserMessage(alice.userId, chat.id, 'Save this as a task so I can reuse it');
    const drafts = new ChatTaskDraftService(prisma, writer('{"name":"Cinema tickets","goal":"Book 2 tickets for the 7:30 PM showing."}').ai);
    const outputs: string[] = [];
    const runTools = jest.fn(async (req: { tools: { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> }[]; onStep?: (s: unknown) => void }) => {
      expect(req.tools.map((t) => t.tool.name).sort()).toEqual(['ask_user', 'draft_task', 'guide_run', 'start_run', 'stop_run']);
      outputs.push(String(await req.tools.find((t) => t.tool.name === 'draft_task')!.execute({}, { userId: 'u' })));
      req.onStep?.({ step: 1, response: { usage: {} }, calls: [] });
      return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
    });
    const ai = { forUser: () => ({ runTools }) } as unknown as AiService;
    const turns = new ChatTurnService(prisma, chats, app.get(ChatResults, { strict: false }), app.get(TasksService, { strict: false }), app.get(JobsService, { strict: false }), ai, drafts);

    expect(await turns.run(chat.id, alice.userId, null)).toBe('answered');
    expect(outputs).toEqual(['Drafted. The owner reviews and saves it from the chat.']);
    const last = await prisma.chatMessage.findFirstOrThrow({ where: { conversationId: chat.id }, orderBy: { seq: 'desc' } });
    expect(last).toMatchObject({ role: 'assistant', kind: 'task_draft', text: 'Book 2 tickets for the 7:30 PM showing.' });
    expect(last.meta).toEqual({ name: 'Cinema tickets', goal: 'Book 2 tickets for the 7:30 PM showing.', profile: 'home', hostId: null, hostFallback: false, policyId: 'builtin:economy', allowedDomains: ['cinema.example.test'], confirmRiskyActions: true, useSavedLogins: false, useSavedIdentity: false, useSavedCards: false, recordVideo: false, parameters: [], outputs: [], connections: [] });
  });
});

describe('POST /chats/:id/task-link', () => {
  it('adds one line that names the saved task and carries its id, however often it is sent', async () => {
    const alice = await login('link');
    const { chat } = await finishedChat(alice);
    const task = await prisma.task.create({ data: { userId: alice.userId, name: 'Cinema tickets', goal: 'Book 2 tickets.' } });
    const first = await post<{ id: string; role: string; text: string; meta: unknown }>(alice, `/chats/${chat.id}/task-link`, { taskId: task.id });
    expect(first.statusCode).toBe(201);
    expect(first.data).toMatchObject({ role: 'system', text: 'Saved as the task "Cinema tickets".', meta: { taskId: task.id } });
    const again = await post<{ id: string }>(alice, `/chats/${chat.id}/task-link`, { taskId: task.id });
    expect(again.data.id).toBe(first.data.id);
    expect(await prisma.chatMessage.count({ where: { conversationId: chat.id, role: 'system' } })).toBe(1);
  });

  it("refuses a task that is not the caller's, another user's chat, and a bad id", async () => {
    const alice = await login('link-owner');
    const mallory = await login('link-other');
    const { chat } = await finishedChat(alice);
    const theirs = await prisma.task.create({ data: { userId: mallory.userId, name: 'Not yours', goal: 'x' } });
    const mine = await prisma.task.create({ data: { userId: alice.userId, name: 'Mine', goal: 'x' } });
    const foreignTask = await post(alice, `/chats/${chat.id}/task-link`, { taskId: theirs.id });
    // (`TASK_NOT_FOUND` is not a registered code: the platform's filter answers the generic one, as on the tasks routes.)
    expect(foreignTask.statusCode).toBe(404);
    const foreignChat = await post(mallory, `/chats/${chat.id}/task-link`, { taskId: theirs.id });
    expect([foreignChat.statusCode, foreignChat.code]).toEqual([404, 'CHAT_NOT_FOUND']);
    expect((await post(alice, `/chats/${chat.id}/task-link`, { taskId: 'nope' })).statusCode).toBe(400);
    expect((await post(alice, `/chats/${chat.id}/task-link`, { taskId: mine.id })).statusCode).toBe(201);
    expect(await prisma.chatMessage.count({ where: { conversationId: chat.id, role: 'system' } })).toBe(1);
  });
});

describe('the accounts a drafted task proposes (E41.5)', () => {
  async function connect(userId: string, label: string, provider: 'google' | 'microsoft' = 'google') {
    return prisma.connection.create({ data: { userId, provider, accountId: `acct-${label}-${Date.now()}-${Math.random()}`, accountEmail: `${label.toLowerCase()}@example.test`, label, capabilities: ['mail_read', 'mail_send', 'calendar_read'], grantedScopes: [], status: 'active' } });
  }

  it('proposes only the chat\'s connections its runs used, at the access they needed, and writes nothing', async () => {
    const alice = await login('accounts');
    const { chat, run } = await finishedChat(alice);
    const [work, home, idle] = [await connect(alice.userId, 'Work'), await connect(alice.userId, 'Home'), await connect(alice.userId, 'Idle')];
    await prisma.conversationConnection.createMany({ data: [work, home, idle].map((c) => ({ conversationId: chat.id, connectionId: c.id, access: 'read_write' })) });
    await prisma.runStep.createMany({
      data: [
        { runId: run.id, seq: 1, kind: 'action', action: 'mail_search', args: { connection: 'Work' }, ok: true },
        { runId: run.id, seq: 2, kind: 'action', action: 'mail_send', args: { connection: 'Work', to: ['person-b@example.test'] }, ok: true },
        { runId: run.id, seq: 3, kind: 'action', action: 'calendar_list', args: { connection: 'Home' }, ok: true },
        // A refused call does not count.
        { runId: run.id, seq: 4, kind: 'action', action: 'mail_send', args: { connection: 'Home' }, ok: false },
        // A label the chat does not list is never proposed.
        { runId: run.id, seq: 5, kind: 'action', action: 'mail_search', args: { connection: 'Someone else' }, ok: true },
      ],
    });
    const before = await prisma.taskConnection.count();
    const draft = await new ChatTaskDraftService(prisma, writer(new Error('no model')).ai).draft(alice.userId, chat.id, null);
    expect(draft.connections).toEqual(expect.arrayContaining([{ connectionId: work.id, access: 'read_write' }, { connectionId: home.id, access: 'read' }]));
    expect(draft.connections).toHaveLength(2);
    expect(await prisma.taskConnection.count()).toBe(before);
  });

  it('proposes none when the chat\'s runs used no account', async () => {
    const bob = await login('accounts-none');
    const { chat } = await finishedChat(bob);
    const c = await connect(bob.userId, 'Work');
    await prisma.conversationConnection.create({ data: { conversationId: chat.id, connectionId: c.id, access: 'read' } });
    const draft = await new ChatTaskDraftService(prisma, writer(new Error('no model')).ai).draft(bob.userId, chat.id, null);
    expect(draft.connections).toEqual([]);
  });
});

describe('"this could have used your account" (E41.5)', () => {
  it('suggests the owner\'s unlisted Google account after a run that used Google Mail in the browser, and not once the run had one', async () => {
    const carol = await login('suggest');
    const { chat, run } = await finishedChat(carol);
    const marin = await prisma.connection.create({ data: { userId: carol.userId, provider: 'google', accountId: `acct-s-${stamp}`, accountEmail: 'marin@example.test', label: 'Marin', capabilities: ['mail_read', 'mail_send'], grantedScopes: [], status: 'active' } });
    await prisma.runStep.create({ data: { runId: run.id, seq: 1, kind: 'action', action: 'navigate', args: { url: 'https://mail.google.com/mail/u/0/' }, ok: true } });
    const got = await suggestedConnections(prisma, carol.userId, { id: run.id, taskId: null, conversationId: chat.id, policySnapshot: null });
    expect(got).toEqual([{ connectionId: marin.id, label: 'Marin', provider: 'google', site: 'Google Mail', scope: 'chat', text: 'This used the browser for Google Mail. You have "Marin" connected: allow it for this chat to do this without the browser.' }]);
    // The chat's result card carries it (never the model).
    await prisma.chatMessage.deleteMany({ where: { conversationId: chat.id, kind: 'result' } });
    await app.get(ChatResults, { strict: false }).recordRunEnd(carol.userId, run.id);
    const result = await prisma.chatMessage.findFirstOrThrow({ where: { conversationId: chat.id, kind: 'result' } });
    expect((result.meta as { suggestedConnections?: unknown[] }).suggestedConnections).toHaveLength(1);
    // The run page: GET /runs/:id.
    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}`, headers: { authorization: `Bearer ${carol.token}` } });
    expect(res.json<{ data: { suggestedConnections: { label: string }[] } }>().data.suggestedConnections.map((s) => s.label)).toEqual(['Marin']);
    // A run that listed a Google mail account: nothing to suggest.
    const snapshot = { connections: [{ connectionId: marin.id, access: 'read', label: 'Marin', provider: 'google', capabilities: ['mail_read'] }] };
    expect(await suggestedConnections(prisma, carol.userId, { id: run.id, taskId: null, conversationId: chat.id, policySnapshot: snapshot })).toEqual([]);
  });
});
