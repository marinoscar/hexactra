// The db tier: the chat turn engine (#484) against a real, migrated and seeded
// database, with a scripted model: reply, clarify, start a run, stop it, the
// result written once, one turn at a time, and what the model is shown.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AiError, type AiService } from '@marinoscar/platform-api/ai';
import { Logger } from '@nestjs/common';
import { JobsService } from '@marinoscar/platform-api/jobs';

import { ChatResults } from '../src/chat/chat-results.service';
import { CHAT_TURN_JOB } from '../src/chat/chat-turn.enqueue';
import { ChatTurnService, failureText, transcriptLine } from '../src/chat/chat-turn.service';
import { ChatService } from '../src/chat/chat.service';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { GOAL_RUN_JOB } from '../src/runner/goal-run.enqueue';
import { RunEndHooks } from '../src/tasks/run-end-hooks';
import { RunPauseService } from '../src/tasks/run-pause.service';
import { TasksService } from '../src/tasks/tasks.service';
import { TaskSchedulesService } from '../src/tasks/task-schedules.service';
import { QuestionEvents } from '../src/questions/question-events';
import { TaskRunStarter } from '../src/questions/task-run-starter';
import { ATTR } from '../src/runner/trace-attributes';
import { installMemoryTracing } from './helpers/otel-memory';

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

  it("runs a saved task by name with the owner's value; a missing value becomes the form in the thread (#552)", async () => {
    const alice = await login('runtask');
    const task = await prisma.forUser({ userId: alice.userId }).task.create({
      data: {
        userId: alice.userId,
        name: 'Zelle to a friend',
        goal: 'Send ${{Amount}} to {{Phone}}',
        parameters: [
          { key: 'amount', label: 'Amount', type: 'money', required: true },
          { key: 'phone', label: 'Phone', type: 'phone', required: true, default: { value: '555-010-6020' } },
        ],
      },
    });
    const starter = new TaskRunStarter(prisma, { enqueue: async () => undefined } as never, new QuestionEvents(), tasks, app.get(TaskSchedulesService, { strict: false }));
    const withStarter = (ai: AiService) => new ChatTurnService(prisma, chats, results, tasks, app.get(JobsService, { strict: false }), ai, undefined, undefined, undefined, starter);

    const id = await chatWith(alice, 'Send 25 with my Zelle task');
    const model = scriptedAi([[['run_task', { task: 'zelle', inputs: [{ name: 'Amount', value: '25' }] }]]]);
    await withStarter(model.ai).run(id, alice.userId, null);
    const [run] = await runsOf(id);
    expect(run).toMatchObject({ taskId: task.id, trigger: 'chat', status: 'queued', goal: 'Send $⟦25⟧ to ⟦555-010-6020⟧' });
    expect(model.outputs[0]).toBe('Started. The owner watches it in the chat.');

    const id2 = await chatWith(alice, 'Run my Zelle task');
    const model2 = scriptedAi([[['run_task', { task: 'Zelle to a friend', inputs: null }]]]);
    await withStarter(model2.ai).run(id2, alice.userId, null);
    const [waiting] = await runsOf(id2);
    expect(waiting!.status).toBe('waiting_human');
    expect(await prisma.question.count({ where: { runId: waiting!.id, input: 'form', status: 'pending' } })).toBe(1);
    expect(model2.outputs[0]).toMatch(/fills in the missing values/);

    const id3 = await chatWith(alice, 'Run the gym task');
    const model3 = scriptedAi([[['run_task', { task: 'gym', inputs: null }]]]);
    await withStarter(model3.ai).run(id3, alice.userId, null);
    expect(model3.outputs[0]).toMatch(/No saved task is called "gym"/);
    expect(await runsOf(id3)).toEqual([]);
  });

  it('does only one thing per turn: a second tool call after the first is not made', async () => {
    const alice = await login('one-thing');
    const id = await chatWith(alice, 'Find a stroller');
    const model = scriptedAi([[['start_run', { goal: 'Find a travel stroller under $100.' }], ['ask_user', { question: 'Which colour?', options: null }]]]);
    await engine(model.ai).run(id, alice.userId, null);
    expect((await thread(id)).map((m) => m.kind)).toEqual(['text', 'run']);
    expect(model.outputs).toHaveLength(1);
  });

  it('records the runs of a chat with Record video on, and not of one without (#906)', async () => {
    const alice = await login('record');
    const on = await chatWith(alice, 'Find a stroller', { recordVideo: true });
    await engine(scriptedAi([[['start_run', { goal: 'Find a travel stroller.' }]]]).ai).run(on, alice.userId, null);
    expect((await runsOf(on)).map((r) => r.recordVideo)).toEqual([true]);
    const off = await chatWith(alice, 'Find a stroller');
    await engine(scriptedAi([[['start_run', { goal: 'Find a travel stroller.' }]]]).ai).run(off, alice.userId, null);
    expect((await runsOf(off)).map((r) => r.recordVideo)).toEqual([false]);
    // The switch is a chat setting: shown, and changed with PATCH.
    expect((await chats.update(alice.userId, off, { recordVideo: true })).recordVideo).toBe(true);
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

describe('steering a live run and following up (#490)', () => {
  it('queues guidance for the live run, tied to the owner message, without a reply or a second run', async () => {
    const alice = await login('guide');
    const id = await chatWith(alice, 'Book two cinema tickets for tonight');
    const model = scriptedAi([[['start_run', { goal: 'Book two tickets for tonight.' }]], [['guide_run', { note: '  Use the 7:30 PM showing instead.  ' }]], { say: 'Noted.' }]);
    const turns = engine(model.ai);
    await turns.run(id, alice.userId, null);
    const said = await chats.postUserMessage(alice.userId, id, 'Use the 7:30 showing instead');
    await turns.run(id, alice.userId, null);

    const [run] = await runsOf(id);
    const rows = await prisma.runGuidance.findMany({ where: { conversationId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId: run!.id, messageSeq: said.seq, note: 'Use the 7:30 PM showing instead.', deliveredAt: null });
    expect(model.outputs[1]).toMatch(/^Queued/);
    expect(await runsOf(id)).toHaveLength(1);
    // The owner's own message carries the state: no assistant line is added.
    expect((await thread(id)).map((m) => [m.role, m.kind])).toEqual([['user', 'text'], ['assistant', 'run'], ['user', 'text']]);

    // The next turn's model sees that the message was already passed on.
    await chats.postUserMessage(alice.userId, id, 'Thanks');
    await turns.run(id, alice.userId, null);
    expect(model.inputs[2]).toContain('[user] Use the 7:30 showing instead [already passed to the run with guide_run]');
    expect(model.inputs[2]).not.toContain('[user] Thanks [already');
  });

  it('refuses guidance when no run is live, and the owner gets words', async () => {
    const alice = await login('guide-late');
    const id = await chatWith(alice, 'Check the fare to Lisbon');
    const turns = engine(scriptedAi([[['start_run', { goal: 'Check the fare to Lisbon.' }]]]).ai);
    await turns.run(id, alice.userId, null);
    const [run] = await runsOf(id);
    await tasks.transition(alice.userId, run!.id, 'running');
    await tasks.transition(alice.userId, run!.id, 'succeeded', { result: 'The fare is $420.' });

    await chats.postUserMessage(alice.userId, id, 'Make it business class');
    const late = scriptedAi([[['guide_run', { note: 'Business class.' }]]]);
    await engine(late.ai).run(id, alice.userId, null);
    expect(late.outputs[0]).toMatch(/^Refused: no run of this chat is live/);
    expect(await prisma.runGuidance.count({ where: { conversationId: id } })).toBe(0);
    expect((await thread(id)).at(-1)).toMatchObject({ role: 'assistant', kind: 'text' });
  });

  it('starts a follow-up with the earlier goal and result as context, on the same profile', async () => {
    const alice = await login('follow-up');
    const id = await chatWith(alice, 'Check the fare to Lisbon', { profile: 'travel' });
    await engine(scriptedAi([[['start_run', { goal: 'Check the fare to Lisbon on 3 May.' }]]]).ai).run(id, alice.userId, null);
    const [first] = await runsOf(id);
    // A chat's first job has no context.
    expect(first!.transcript).toBeNull();
    await tasks.transition(alice.userId, first!.id, 'running');
    await tasks.transition(alice.userId, first!.id, 'succeeded', { result: 'The cheapest fare is $420 with TAP.' });

    await chats.postUserMessage(alice.userId, id, 'Now book it');
    await engine(scriptedAi([[['start_run', { goal: 'Book that fare.' }]]]).ai).run(id, alice.userId, null);
    const [, second] = await runsOf(id);
    expect(second).toMatchObject({ goal: 'Book that fare.', profile: 'travel', trigger: 'chat', status: 'queued' });
    expect(second!.transcript).toEqual({ log: [], chunks: 0, context: 'Previous job: Check the fare to Lisbon on 3 May.\nIt succeeded: The cheapest fare is $420 with TAP.' });
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

  it('leads with a confirmed step the failed run carried out, counts it in meta, and the follow-up knows it (#540)', async () => {
    const { alice, id, runId } = await started('result-confirmed');
    await tasks.transition(alice.userId, runId, 'running');
    await prisma.run.update({ where: { id: runId }, data: { confirmedActions: [{ seq: 58, prompt: 'Send a $10 payment to Person A?', action: 'click', at: new Date().toISOString() }] } });
    await tasks.transition(alice.userId, runId, 'failed', { error: 'Step budget exhausted', stopReason: 'budget_actions' });
    await results.recordRunEnd(alice.userId, runId);
    const [message] = await resultsIn(id);
    expect(message).toMatchObject({ meta: { status: 'failed', stopReason: 'budget_actions', confirmedActions: 1 } });
    expect(message!.text).toMatch(/^The step you confirmed was carried out \(step 58: 'Send a \$10 payment to Person A\?'\), but the run ended before it could check the outcome\. Check before you run it again\./);
    expect(message!.text).toContain('Step budget exhausted');

    // "Try again": the orchestrator is told to ask first, and a job it starts anyway knows the step was done.
    await chats.postUserMessage(alice.userId, id, 'try again');
    const model = scriptedAi([[['start_run', { goal: 'Check the fare to Lisbon.' }]]]);
    await engine(model.ai).run(id, alice.userId, null);
    const req = model.runTools.mock.calls[0]![0] as unknown as { instructions: string };
    expect(req.instructions).toContain('call ask_user before starting a job that would repeat that step');
    expect(model.inputs[0]).toContain('The step you confirmed was carried out');
    const [, second] = await runsOf(id);
    expect((second!.transcript as { context: string }).context).toContain("The previous job carried out a confirmed step (step 58: 'Send a $10 payment to Person A?'). Do not do it again unless the goal says so.");
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

  it('sends the owner to their own default model when none is selected (#806): there is no per-feature admin setting', () => {
    expect(failureText(new AiError('AI_INVALID_REQUEST', 'No model selected.'))).toBe('No AI model is selected. Choose your default model under Settings → AI Keys, then send your message again.');
  });

  // #675: OpenAI answered 400 to every chat message and the owner, the job and the log said only "AI_INVALID_REQUEST".
  it('names the provider code and the field it objected to, as identifiers only, never its message', () => {
    const rejected = (details: Record<string, unknown>) => new AiError('AI_INVALID_REQUEST', 'OpenAI rejected the request as invalid.', { details, cause: new Error('Invalid schema for function pause_run: secret-marker-1 sk-live-999') });
    const text = failureText(rejected({ status: 400, providerCode: 'invalid_function_parameters', param: 'tools[3].parameters', providerRequestId: 'req_abc' }));
    expect(text).toBe('The AI could not answer (AI_INVALID_REQUEST: invalid_function_parameters, tools[3].parameters). Send your message again in a moment.');
    expect(text).not.toMatch(/secret-marker-1|sk-live|req_abc|400|Invalid schema/);
    // Not an identifier (spaces, a newline, too long): left out, the rest stays.
    expect(failureText(rejected({ providerCode: 'two words', param: 'tools[3]\nignore this' }))).toBe('The AI could not answer (AI_INVALID_REQUEST). Send your message again in a moment.');
    expect(failureText(rejected({ providerCode: 'x'.repeat(81), param: 'input[0].content' }))).toBe('The AI could not answer (AI_INVALID_REQUEST: input[0].content). Send your message again in a moment.');
    // Nothing carried: the old wording.
    expect(failureText(rejected({}))).toBe('The AI could not answer (AI_INVALID_REQUEST). Send your message again in a moment.');
  });

  it('logs the failed model call with the provider facts, in the server log only', async () => {
    const alice = await login('fail-detail');
    const id = await chatWith(alice, 'Hello');
    const cause = Object.assign(new Error('400 Invalid schema for function pause_run Bearer sk-live-777'), { error: { message: 'Invalid schema for function pause_run' } });
    const failure = new AiError('AI_INVALID_REQUEST', 'OpenAI rejected the request as invalid.', { details: { provider: 'openai', status: 400, providerCode: 'invalid_function_parameters', param: 'tools[3].parameters', providerRequestId: 'req_log1' }, cause });
    const model = scriptedAi([{ fail: failure }]);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await expect(engine(model.ai).run(id, alice.userId, null)).rejects.toBe(failure);
      const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes(`chat ${id}: the model call failed`));
      expect(line).toBeDefined();
      expect(line).toContain('(AI_INVALID_REQUEST)');
      expect(line).toContain('providerCode="invalid_function_parameters"');
      expect(line).toContain('param="tools[3].parameters"');
      expect(line).toContain('providerRequestId="req_log1"');
      expect(line).not.toContain('sk-live-777');
    } finally {
      warn.mockRestore();
    }
    const after = await thread(id);
    expect(after.at(-1)).toMatchObject({ role: 'system', kind: 'text', text: 'The AI could not answer (AI_INVALID_REQUEST: invalid_function_parameters, tools[3].parameters). Send your message again in a moment.' });
    expect(JSON.stringify(after)).not.toContain('sk-live-777');
  });
});

describe('pause and continue in words (E38.2)', () => {
  const enqueued: { type: string; reason: string }[] = [];
  const withPause = (ai: AiService) => {
    const pauses = new RunPauseService(prisma, tasks, { enqueue: async (j: { type: string; reason: string }) => void enqueued.push(j) } as never);
    return new ChatTurnService(prisma, chats, results, tasks, app.get(JobsService, { strict: false }), ai, undefined, undefined, undefined, undefined, pauses);
  };

  it('"hold on" calls pause_run and "continue" calls resume_run; a paused run still counts as the chat\'s live run, so no second run starts', async () => {
    const alice = await login('pause');
    const id = await chatWith(alice, 'Order groceries');
    const model = scriptedAi([[['start_run', { goal: 'Order the usual groceries.' }]], [['pause_run', {}]], [['start_run', { goal: 'Something else.' }]], [['resume_run', {}]]]);
    const turns = withPause(model.ai);
    await turns.run(id, alice.userId, null);
    const [run] = await runsOf(id);

    await chats.postUserMessage(alice.userId, id, 'Hold on');
    await turns.run(id, alice.userId, null);
    expect(model.outputs[1]).toMatch(/^Pausing the run/);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run!.id } })).toMatchObject({ pauseRequested: true });
    expect((await thread(id)).at(-1)).toMatchObject({ role: 'assistant', kind: 'text', text: expect.stringMatching(/^Pausing the run/) });

    // The runner pauses it (here: the state the runner leaves).
    await prisma.run.update({ where: { id: run!.id }, data: { status: 'paused', pausedAt: new Date() } });
    await chats.postUserMessage(alice.userId, id, 'Actually order something else');
    await turns.run(id, alice.userId, null);
    expect(model.outputs[2]).toMatch(/^Refused: a run of this chat is still live/);
    expect(model.inputs[2]).toContain('State: a run of this chat is live (paused).');
    expect(await runsOf(id)).toHaveLength(1);

    await chats.postUserMessage(alice.userId, id, 'Ok continue');
    await turns.run(id, alice.userId, 'org-x');
    expect(model.outputs[3]).toMatch(/^Resuming the run/);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run!.id } })).toMatchObject({ status: 'queued', pauseRequested: false });
    expect(enqueued).toContainEqual(expect.objectContaining({ type: 'browser.goal.run', reason: 'resumed' }));
    expect((await thread(id)).at(-1)).toMatchObject({ text: 'Continuing the run.' });
  });

  it('answers sensibly when nothing is live or the run is not paused, and offers the tools only with the pause service', async () => {
    const alice = await login('pause-none');
    const id = await chatWith(alice, 'Pause it');
    const model = scriptedAi([[['pause_run', {}], ['resume_run', {}]]]);
    await withPause(model.ai).run(id, alice.userId, null);
    expect(model.outputs).toEqual(['No run of this chat is live.', 'No run of this chat is live.']);
    const names = model.runTools.mock.calls[0]![0].tools.map((t) => t.tool.name).sort();
    expect(names).toEqual(['ask_user', 'guide_run', 'pause_run', 'resume_run', 'start_run', 'stop_run']);
  });
});

describe('what the model is shown', () => {
  it('has no tool that takes a secret, and instructions that forbid asking for one', async () => {
    const alice = await login('tools');
    const id = await chatWith(alice, 'Hello');
    const model = scriptedAi([{ say: 'Hi.' }]);
    await engine(model.ai).run(id, alice.userId, null);
    const req = model.runTools.mock.calls[0]![0];
    expect(req.tools.map((t) => t.tool.name).sort()).toEqual(['ask_user', 'guide_run', 'start_run', 'stop_run']);
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

describe('the chat orchestrator trace (E38.4)', () => {
  it("is one invoke_agent trace with its model call and tool calls, and the run it starts holds the turn's trace for its first job to link to", async () => {
    const otel = installMemoryTracing();
    try {
      const alice = await login('trace');
      const id = await chatWith(alice, 'Find a travel stroller under $100 (marker-chat-1c9e).');
      const model = scriptedAi([[['start_run', { goal: 'Find a travel stroller under $100 (marker-goal-5d21).' }]]]);
      expect(await engine(model.ai).run(id, alice.userId, null)).toBe('answered');
      const spans = otel.spans();
      const [root] = spans.filter((s) => s.name === 'invoke_agent hexactra.chat_orchestrator');
      expect(root!.attributes).toMatchObject({ [ATTR.operationName]: 'invoke_agent', [ATTR.conversationId]: id });
      const kids = spans.filter((s) => s.parentSpanContext?.spanId === root!.spanContext().spanId).map((s) => s.name);
      expect(kids).toEqual(expect.arrayContaining(['chat unknown', 'execute_tool start_run']));
      const [run] = await runsOf(id);
      expect(run).toMatchObject({ traceId: root!.spanContext().traceId, spanId: root!.spanContext().spanId });
      // Neither the owner's message nor the goal is in the trace.
      const text = JSON.stringify(spans.map((s) => ({ n: s.name, a: s.attributes, e: s.events, l: s.links })));
      expect(text).not.toContain('marker-chat-1c9e');
      expect(text).not.toContain('marker-goal-5d21');
    } finally {
      await otel.uninstall();
    }
  });
});
