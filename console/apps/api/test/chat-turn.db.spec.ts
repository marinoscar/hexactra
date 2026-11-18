// The db tier: the chat turn engine (#484) against a real, migrated and seeded
// database, with a scripted model: reply, clarify, start a run, stop it, the
// result written once, one turn at a time, and what the model is shown.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';
import { JobsService } from '@marinoscar/platform-api/jobs';

import { ChatResults } from '../src/chat/chat-results.service';
import { CHAT_TURN_JOB } from '../src/chat/chat-turn.enqueue';
import { ChatTurnService, failureText, transcriptLine } from '../src/chat/chat-turn.service';
import { ChatService } from '../src/chat/chat.service';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { GOAL_RUN_JOB } from '../src/runner/goal-run.enqueue';
import { RunEndHooks } from '../src/tasks/run-end-hooks';
import { TasksService } from '../src/tasks/tasks.service';

let app: NestFastifyApplication;
let prisma: PrismaService;
let chats: ChatService;
let results: ChatResults;
let tasks: TasksService;
const stamp = `${Date.now()}`;

// No job worker in this app: the tests run each turn themselves, with their own model.
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
  results = app.get(ChatResults, { strict: false });
  tasks = app.get(TasksService, { strict: false });
});
afterAll(async () => {
  await app?.close();
});

type Session = { token: string; userId: string };
async function login(name: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `turn-${name}-${stamp}@example.test`, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
async function post<T = unknown>(s: Session, url: string, payload: unknown): Promise<{ statusCode: number; data: T }> {
  const res = await app.inject({ method: 'POST', url: `/api${url}`, headers: { authorization: `Bearer ${s.token}` }, payload: payload as object });
  return { statusCode: res.statusCode, data: res.json<{ data: T }>().data };
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
function scriptedAi(rounds: Round[]) {
  const outputs: string[] = [];
  const inputs: string[] = [];
  const features: unknown[] = [];
  const runTools = jest.fn(async (req: ToolRequest) => {
    inputs.push(req.input);
    const round = rounds.shift() ?? [];
    if ('fail' in round) throw round.fail;
    if ('say' in round) return { final: { outputText: round.say }, steps: [], stopReason: 'done' };
    let step = 0;
    for (const [name, args] of round) {
      const t = req.tools.find((x) => x.tool.name === name)!;
      outputs.push(String(await t.execute(args, { userId: 'u' })));
      req.onStep?.({ step: ++step, response: { usage: { inputTokens: 10, outputTokens: 5 } }, calls: [] });
    }
    return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
  });
  const ai = { forUser: (_userId: string, opts: unknown) => (features.push(opts), { runTools }) } as unknown as AiService;
  return { ai, runTools, outputs, inputs, features };
}

const engine = (ai: AiService) => new ChatTurnService(prisma, chats, results, tasks, app.get(JobsService, { strict: false }), ai);
async function chatWith(s: Session, text: string, settings: Record<string, unknown> = {}): Promise<string> {
  const chat = await chats.create(s.userId, settings);
  await chats.postUserMessage(s.userId, chat.id, text);
  return chat.id;
}
const thread = async (id: string) =>
  (await prisma.chatMessage.findMany({ where: { conversationId: id }, orderBy: { seq: 'asc' } })).map((m) => ({ role: m.role, kind: m.kind, text: m.text, runId: m.runId, meta: m.meta }));
const runsOf = (id: string) => prisma.run.findMany({ where: { conversationId: id }, orderBy: { createdAt: 'asc' } });

describe('a turn', () => {
  it('replies in plain text through the chat feature, and answers a message once', async () => {
    const alice = await login('reply');
    const id = await chatWith(alice, 'Hello there');
    const model = scriptedAi([{ say: 'Hi. What should I do in the browser?' }]);
    const turns = engine(model.ai);

    expect(await turns.run(id, alice.userId, null)).toBe('answered');
    expect(await thread(id)).toMatchObject([
      { role: 'user', kind: 'text', text: 'Hello there' },
      { role: 'assistant', kind: 'text', text: 'Hi. What should I do in the browser?' },
    ]);
    expect(model.features).toEqual([{ feature: 'chat_orchestrator' }]);
    expect(model.inputs[0]).toContain('[user] Hello there');
    expect(model.inputs[0]).toContain('State: no run is live.');

    // A second job for the same message finds nothing to answer.
    expect(await turns.run(id, alice.userId, null)).toBe('idle');
    expect(model.runTools).toHaveBeenCalledTimes(1);
    const c = await prisma.conversation.findUniqueOrThrow({ where: { id } });
    expect(c).toMatchObject({ answeredSeq: 1, turnLeaseUntil: null });
  });

  it('asks one clarifying question with suggested answers, then starts a run with the chat settings', async () => {
    const alice = await login('clarify');
    const id = await chatWith(alice, 'Book cinema tickets for tonight', { profile: 'home', hostFallback: false, policyId: 'builtin:economy' });
    const model = scriptedAi([[['ask_user', { question: 'Which showing?', options: ['4:30 PM', '7:30 PM'] }]], [['start_run', { goal: '  Book 2 tickets for the 7:30 PM showing tonight.  ' }]]]);
    const turns = engine(model.ai);

    await turns.run(id, alice.userId, 'org-x');
    expect((await thread(id))[1]).toMatchObject({ role: 'assistant', kind: 'clarify', text: 'Which showing?', meta: { options: ['4:30 PM', '7:30 PM'] } });
    expect(await runsOf(id)).toEqual([]);

    await chats.postUserMessage(alice.userId, id, '7:30 PM, two seats');
    await turns.run(id, alice.userId, null);
    const [run] = await runsOf(id);
    expect(run).toMatchObject({ userId: alice.userId, trigger: 'chat', status: 'queued', goal: 'Book 2 tickets for the 7:30 PM showing tonight.', profile: 'home', hostFallback: false, policyRef: 'builtin:economy', policySource: 'run', taskId: null });
    expect((await thread(id))[3]).toMatchObject({ role: 'assistant', kind: 'run', text: 'Book 2 tickets for the 7:30 PM showing tonight.', runId: run!.id });
    expect(model.inputs[1]).toContain('[assistant asked] Which showing? (suggested: 4:30 PM | 7:30 PM)');
    // The goal runner's job was queued for the run.
    expect(await prisma.job.count({ where: { type: GOAL_RUN_JOB, subjectId: run!.id } })).toBe(1);
    expect((await chats.get(alice.userId, id)).liveRun).toEqual({ id: run!.id, status: 'queued' });
  });

  it('does only one thing per turn: a second tool call after the first is not made', async () => {
    const alice = await login('one-thing');
    const id = await chatWith(alice, 'Find a stroller');
    const model = scriptedAi([[['start_run', { goal: 'Find a travel stroller under $100.' }], ['ask_user', { question: 'Which colour?', options: null }]]]);
    await engine(model.ai).run(id, alice.userId, null);
    expect((await thread(id)).map((m) => m.kind)).toEqual(['text', 'run']);
    expect(model.outputs).toHaveLength(1);
  });

  it('refuses a second run while one is live, and says so to the model', async () => {
    const alice = await login('one-run');
    const id = await chatWith(alice, 'Order groceries');
    const model = scriptedAi([[['start_run', { goal: 'Order the usual groceries.' }]], [['start_run', { goal: 'Also order flowers.' }]]]);
    const turns = engine(model.ai);
    await turns.run(id, alice.userId, null);
    await chats.postUserMessage(alice.userId, id, 'And flowers');
    await turns.run(id, alice.userId, null);

    expect(await runsOf(id)).toHaveLength(1);
    expect(model.outputs[1]).toMatch(/^Refused: a run of this chat is still live/);
    expect(model.inputs[1]).toContain('State: a run of this chat is live (queued).');
    // Nothing was started, so the owner still gets words.
    expect((await thread(id)).at(-1)).toMatchObject({ role: 'assistant', kind: 'text' });
  });

  it('stops the live run when asked, and the thread says how it ended, once', async () => {
    const alice = await login('stop');
    const id = await chatWith(alice, 'Order groceries');
    const model = scriptedAi([[['start_run', { goal: 'Order the usual groceries.' }]], [['stop_run', {}]], [['stop_run', {}]]]);
    const turns = engine(model.ai);
    await turns.run(id, alice.userId, null);
    await chats.postUserMessage(alice.userId, id, 'Stop');
    await turns.run(id, alice.userId, null);

    const [run] = await runsOf(id);
    expect(run).toMatchObject({ status: 'cancelled', stopReason: 'cancelled' });
    const after = await thread(id);
    expect(after.map((m) => [m.role, m.kind])).toEqual([['user', 'text'], ['assistant', 'run'], ['user', 'text'], ['assistant', 'result'], ['assistant', 'text']]);
    expect(after[3]).toMatchObject({ runId: run!.id, text: 'Cancelled before it started', meta: { status: 'cancelled', stopReason: 'cancelled' } });
    expect(after[4]!.text).toBe('Stopping the run.');

    // Asked again with nothing live: the model is told so.
    await chats.postUserMessage(alice.userId, id, 'Stop!');
    await turns.run(id, alice.userId, null);
    expect(model.outputs.at(-1)).toBe('No run of this chat is live.');
    expect((await thread(id)).filter((m) => m.kind === 'result')).toHaveLength(1);
  });
});

describe('the result of a chat run', () => {
  async function started(name: string) {
    const alice = await login(name);
    const id = await chatWith(alice, 'Check the fare');
    await engine(scriptedAi([[['start_run', { goal: 'Check the fare to Lisbon.' }]]]).ai).run(id, alice.userId, null);
    const [run] = await runsOf(id);
    return { alice, id, runId: run!.id };
  }
  const resultsIn = async (id: string) => (await thread(id)).filter((m) => m.kind === 'result');

  it('is written when the run succeeds, with its cost, and only once however often it is noticed', async () => {
    const { alice, id, runId } = await started('result-ok');
    await tasks.transition(alice.userId, runId, 'running');
    expect(await resultsIn(id)).toEqual([]);
    await tasks.transition(alice.userId, runId, 'succeeded', { result: 'The fare is 84 EUR.', stopReason: 'finished' });

    await Promise.all([results.recordRunEnd(alice.userId, runId), results.recordRunEnd(alice.userId, runId), results.sync(alice.userId, id)]);
    expect(await resultsIn(id)).toMatchObject([{ role: 'assistant', runId, text: 'The fare is 84 EUR.', meta: { status: 'succeeded', stopReason: 'finished', costUsd: 0, costKnown: true, stepCount: 0 } }]);
    // No gap in the numbering from the attempts that wrote nothing.
    const seqs = (await prisma.chatMessage.findMany({ where: { conversationId: id }, orderBy: { seq: 'asc' }, select: { seq: true } })).map((m) => m.seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('is the error when the run fails, including on the job failure path', async () => {
    const { alice, id, runId } = await started('result-fail');
    // What GoalRunHandler does when the runner throws: a direct write, then the hooks.
    await prisma.run.update({ where: { id: runId }, data: { status: 'failed', error: 'provider_unavailable: no model answered', stopReason: 'error', finishedAt: new Date() } });
    await app.get(RunEndHooks, { strict: false }).fire(alice.userId, runId);
    expect(await resultsIn(id)).toMatchObject([{ runId, text: 'provider_unavailable: no model answered', meta: { status: 'failed', stopReason: 'error' } }]);
  });

  it('is caught up by the next turn when no hook fired', async () => {
    const { alice, id, runId } = await started('result-sync');
    await prisma.run.update({ where: { id: runId }, data: { status: 'succeeded', result: 'Done quietly.', finishedAt: new Date() } });
    await chats.postUserMessage(alice.userId, id, 'What happened?');
    const model = scriptedAi([{ say: 'It finished.' }]);
    await engine(model.ai).run(id, alice.userId, null);
    expect((await thread(id)).map((m) => m.kind)).toEqual(['text', 'run', 'text', 'result', 'text']);
    expect(model.inputs[0]).toContain('[run succeeded] Done quietly.');
  });

  it('is not written for a run no chat started, nor for a live run', async () => {
    const alice = await login('result-none');
    const adhoc = await prisma.run.create({ data: { userId: alice.userId, goal: 'Unrelated', status: 'succeeded' } });
    await expect(results.recordRunEnd(alice.userId, adhoc.id)).resolves.toBeUndefined();
    const { id, runId } = await started('result-live');
    await results.recordRunEnd((await prisma.run.findUniqueOrThrow({ where: { id: runId } })).userId, runId);
    expect(await resultsIn(id)).toEqual([]);
  });
});

describe('one turn at a time', () => {
  it('is busy while another turn holds the chat, and takes over an expired lease', async () => {
    const alice = await login('busy');
    const id = await chatWith(alice, 'Hello');
    const model = scriptedAi([{ say: 'Hi.' }]);
    const turns = engine(model.ai);

    await prisma.conversation.update({ where: { id }, data: { turnLeaseUntil: new Date(Date.now() + 60_000) } });
    expect(await turns.run(id, alice.userId, null)).toBe('busy');
    expect(model.runTools).not.toHaveBeenCalled();
    expect((await chats.get(alice.userId, id)).thinking).toBe(true);

    await prisma.conversation.update({ where: { id }, data: { turnLeaseUntil: new Date(Date.now() - 1_000) } });
    expect((await chats.get(alice.userId, id)).thinking).toBe(false);
    expect(await turns.run(id, alice.userId, null)).toBe('answered');
  });

  it('answers a message that arrived during the turn in the same job', async () => {
    const alice = await login('during');
    const id = await chatWith(alice, 'First');
    const rounds: Round[] = [{ say: 'Answer one.' }, { say: 'Answer two.' }];
    const model = scriptedAi(rounds);
    // The second message lands while the first model call is in flight.
    model.runTools.mockImplementationOnce(async (req: ToolRequest) => {
      model.inputs.push(req.input);
      await chats.postUserMessage(alice.userId, id, 'Second');
      rounds.shift();
      return { final: { outputText: 'Answer one.' }, steps: [], stopReason: 'done' };
    });
    expect(await engine(model.ai).run(id, alice.userId, null)).toBe('answered');
    expect((await thread(id)).map((m) => m.text)).toEqual(['First', 'Second', 'Answer one.', 'Answer two.']);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id } })).answeredSeq).toBe(2);
  });

  it('does nothing for an archived chat, a missing chat or another user', async () => {
    const alice = await login('idle');
    const mallory = await login('idle-other');
    const id = await chatWith(alice, 'Hello');
    const model = scriptedAi([]);
    const turns = engine(model.ai);
    expect(await turns.run(id, mallory.userId, null)).toBe('idle');
    expect(await turns.run('00000000-0000-4000-8000-000000000000', alice.userId, null)).toBe('idle');
    await chats.update(alice.userId, id, { status: 'archived' });
    expect(await turns.run(id, alice.userId, null)).toBe('idle');
    expect(model.runTools).not.toHaveBeenCalled();
  });
});

describe('when the model fails', () => {
  it('tells the owner in the thread, releases the chat and does not answer that message again', async () => {
    const alice = await login('fail');
    const id = await chatWith(alice, 'Hello');
    const model = scriptedAi([{ fail: new Error('socket hang up: POST https://provider.example.test/v1 sk-live-123') }, { say: 'Hi.' }]);
    const turns = engine(model.ai);

    await expect(turns.run(id, alice.userId, null)).rejects.toThrow('socket hang up');
    const after = await thread(id);
    expect(after.at(-1)).toMatchObject({ role: 'system', kind: 'text', text: 'Something went wrong while answering. Send your message again.' });
    expect(JSON.stringify(after)).not.toContain('sk-live-123');
    expect(await prisma.conversation.findUniqueOrThrow({ where: { id } })).toMatchObject({ turnLeaseUntil: null, answeredSeq: 1 });
    expect(await turns.run(id, alice.userId, null)).toBe('idle');

    await chats.postUserMessage(alice.userId, id, 'Hello again');
    expect(await turns.run(id, alice.userId, null)).toBe('answered');
  });

  it('words a failure without the provider message', () => {
    expect(failureText(new Error('boom'))).toBe('Something went wrong while answering. Send your message again.');
  });
});

describe('what the model is shown', () => {
  it('has no tool that takes a secret, and instructions that forbid asking for one', async () => {
    const alice = await login('tools');
    const id = await chatWith(alice, 'Hello');
    const model = scriptedAi([{ say: 'Hi.' }]);
    await engine(model.ai).run(id, alice.userId, null);
    const req = model.runTools.mock.calls[0]![0];
    expect(req.tools.map((t) => t.tool.name).sort()).toEqual(['ask_user', 'start_run', 'stop_run']);
    expect(req.instructions).toMatch(/Never ask for a password, a code, a card number/);
  });

  it("never includes a question's answer: only chat messages", async () => {
    const alice = await login('no-answers');
    const id = await chatWith(alice, 'Sign in and check my balance');
    await engine(scriptedAi([[['start_run', { goal: 'Sign in to the bank and read the balance.' }]]]).ai).run(id, alice.userId, null);
    const [run] = await runsOf(id);
    await prisma.question.create({
      data: { ownerUserId: alice.userId, askedBy: `run:${run!.id}`, runId: run!.id, input: 'text', kind: 'code', prompt: 'Enter the code from your phone', status: 'answered', response: { outcome: 'answered', value: '918273', valueWithheld: false }, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    const input = await engine(scriptedAi([]).ai).buildInput(alice.userId, id);
    expect(input).toContain('[run started] Sign in to the bank and read the balance.');
    expect(input).not.toContain('918273');
    expect(input).not.toContain('Enter the code');
  });

  it('renders each kind of message on one labelled line and clips a long one', () => {
    expect(transcriptLine({ role: 'user', kind: 'text', text: ' hi ', meta: null })).toBe('[user] hi');
    expect(transcriptLine({ role: 'assistant', kind: 'result', text: 'Booked', meta: { status: 'succeeded' } })).toBe('[run succeeded] Booked');
    expect(transcriptLine({ role: 'assistant', kind: 'clarify', text: 'Which?', meta: null })).toBe('[assistant asked] Which?');
    expect(transcriptLine({ role: 'user', kind: 'text', text: 'x'.repeat(5000), meta: null })).toHaveLength('[user] '.length + 2000);
  });
});

describe('POST /chats/:id/messages', () => {
  it('queues a chat.turn job for the conversation, one per message', async () => {
    const alice = await login('queue');
    const chat = await chats.create(alice.userId, {});
    expect((await post(alice, `/chats/${chat.id}/messages`, { text: 'One' })).statusCode).toBe(201);
    expect((await post(alice, `/chats/${chat.id}/messages`, { text: 'Two' })).statusCode).toBe(201);
    const jobs = await prisma.job.findMany({ where: { type: CHAT_TURN_JOB, subjectId: chat.id } });
    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.payload).toMatchObject({ conversationId: chat.id, userId: alice.userId });
  });
});
