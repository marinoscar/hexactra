// The chat-front scenarios (E41.1, #698): what the chat's model does with the newest owner message. Each `*.chat.json` holds a conversation
// (the owner's messages, the runs that were started and their results), the chat's accounts and the newest message; the harness drives the
// real `ChatTurnService` over the real database and records the tool the model called. In CI the model is the file's script; live, it is
// the configured `chat_orchestrator` model. Invented data only (`Person A`, `*.example.test`).
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';
import { JobsService } from '@marinoscar/platform-api/jobs';
import { z } from 'zod';

import { ChatResults } from '../../src/chat/chat-results.service';
import { CHAT_CONNECTION_TOOLS } from '../../src/chat/chat-connection-tools';
import { ChatTurnService } from '../../src/chat/chat-turn.service';
import { ChatService } from '../../src/chat/chat.service';
import { CapabilityProviderRegistry } from '../../src/connections/capability-provider.registry';
import { ConnectionCapabilities } from '../../src/connections/connection-capabilities.service';
import { ConnectionProviderRegistry } from '../../src/connections/connection-provider.registry';
import type { Capability } from '../../src/connections/connections.constants';
import { FakeCapabilityProvider } from '../../src/connections/testing';
import { PrismaService } from '../../src/prisma/prisma.service';
import { TaskRunStarter } from '../../src/questions/task-run-starter';
import { RunBatchService } from '../../src/tasks/run-batch.service';
import { TasksService } from '../../src/tasks/tasks.service';
import { FakeWebFetch, FakeWebSearch } from '@marinoscar/hexactra-web-agent/testing';

/** The chat's read tools: what `expect.tool: "read"` accepts. */
export const CHAT_READ_TOOLS = CHAT_CONNECTION_TOOLS.map((t) => t.name);

const turnSchema = z.discriminatedUnion('role', [
  z.strictObject({ role: z.literal('user'), text: z.string().min(1) }),
  z.strictObject({ role: z.literal('assistant'), text: z.string().min(1) }),
  z.strictObject({ role: z.literal('run'), goal: z.string().min(1), status: z.enum(['succeeded', 'failed', 'cancelled']), result: z.string() }).describe('A job the chat started and how it ended'),
]);

const chatExpectSchema = z.strictObject({
  tool: z.string().min(1).describe('start_run, ask_user, read (any read tool of the chat), none (a plain reply), or another tool name'),
  goalIncludes: z.array(z.string()).default([]).describe('start_run: texts the goal contains'),
  goalMustNotInclude: z.array(z.string()).default([]).describe('start_run: regexes (case-insensitive) the goal must not match'),
  batchRows: z.number().int().min(2).optional().describe('run_task_batch (E51.1): the rows the batch waits in review with; no run has started'),
  noRun: z.boolean().optional().describe('The turn started no run (E50.7)'),
  task: z.string().optional().describe('run_task: the task it names (#1007)'),
  inputs: z.record(z.string(), z.string()).optional().describe('run_task: values it passes, by parameter name (#1007)'),
  options: z.array(z.string()).optional().describe('ask_user: the suggested answers it offers, every one of them (#1007)'),
  inputIncludes: z.array(z.string()).default([]).describe("Texts the model's input contains (#1007)"),
  inputMustNotInclude: z.array(z.string()).default([]).describe("Texts the model's input must not contain (#1007)"),
});

const taskParamSchema = z.strictObject({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['text', 'number', 'money', 'date', 'choice', 'phone', 'email']).default('text'),
  required: z.boolean().default(true),
  default: z.strictObject({ value: z.string() }).optional(),
  sensitive: z.boolean().optional(),
});

export const chatScenarioSchema = z.strictObject({
  $schema: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  connections: z
    .array(z.strictObject({ label: z.string().min(1), provider: z.enum(['google', 'microsoft']).default('google'), access: z.enum(['read', 'read_write']).default('read_write'), capabilities: z.array(z.string()).min(1), mail: z.array(z.strictObject({ from: z.string(), subject: z.string(), body: z.string(), date: z.string() })).default([]) }))
    .default([]),
  tasks: z.array(z.strictObject({ name: z.string().min(1), goal: z.string().min(1), parameters: z.array(taskParamSchema).default([]) })).default([]).describe("The owner's saved tasks (#1007; run_task_batch, E51.1)"),
  conversation: z.array(turnSchema).default([]),
  web: z
    .strictObject({ results: z.record(z.string(), z.array(z.strictObject({ title: z.string(), url: z.string(), snippet: z.string() }))).default({}) })
    .optional()
    .describe('Web search set up and switched on for the owner (E50.7), with these results by query. Absent: not set up'),
  message: z.string().min(1).describe('The newest owner message: what the turn answers'),
  script: z.array(z.tuple([z.string(), z.record(z.string(), z.unknown())])).default([]).describe('Scripted mode: the tool calls of the model\'s first round trip'),
  expect: chatExpectSchema,
  pending: z.strictObject({ issue: z.string(), expect: chatExpectSchema.partial() }).optional().describe('Expectations reported but not failing CI until the named issue lands'),
});
export type ChatScenario = z.infer<typeof chatScenarioSchema>;
type ChatExpect = z.infer<typeof chatExpectSchema>;

export interface ChatFrontResult {
  scenario: ChatScenario;
  /** The tool the model called first (`none` for a plain reply), and its arguments. */
  tool: string;
  args: Record<string, unknown> | null;
  /** Every call, in order. */
  calls: { tool: string; args: Record<string, unknown>; output?: string }[];
  /** The runs the turn started, before the harness removes them (#1007). */
  runs: { taskId: string | null }[];
  /** The model's input of the first round trip, and the tools it was offered (#1007). */
  input: string;
  offered: string[];
  failures: string[];
  pendingFailures: string[];
  pass: boolean;
}

/** The Markdown of a live chat-front run: per scenario, the passes and what the model called; the pending expectations apart. */
export function chatLiveMarkdown(results: ChatFrontResult[][], generatedAt: string): string {
  const lines = [`# Live chat front`, '', `Generated ${generatedAt}. ${results[0]?.length ?? 0} run(s) per scenario.`, '', '| scenario | pass rate | tools called |', '|---|---|---|'];
  for (const runs of results) {
    const s = runs[0]!.scenario;
    const passes = runs.filter((r) => r.pass).length;
    lines.push(`| ${s.name} | ${Math.round((passes / runs.length) * 100)}% (${passes}/${runs.length}) | ${[...new Set(runs.map((r) => r.tool))].join(', ')} |`);
  }
  const pending = results.flatMap((runs) => [...new Set(runs.flatMap((r) => r.pendingFailures))].map((p) => `- ${runs[0]!.scenario.name}: ${p}`));
  const failed = results.flatMap((runs) => [...new Set(runs.flatMap((r) => r.failures))].map((f) => `- ${runs[0]!.scenario.name}: ${f}`));
  if (failed.length) lines.push('', 'Failures:', '', ...failed);
  if (pending.length) lines.push('', 'Pending expectations (not counted as failures):', '', ...pending);
  return `${lines.join('\n')}\n`;
}

/** Every `*.chat.json` of a folder, parsed; an invalid file throws with the file and the fields named. */
export function loadChatScenarios(dir: string): { file: string; scenario: ChatScenario }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.chat.json'))
    .sort()
    .map((f) => {
      const file = join(dir, f);
      const parsed = chatScenarioSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
      return { file, scenario: parsed.data };
    });
}

/** What differs from an expectation, in words. */
export function evaluateChat(r: Pick<ChatFrontResult, 'tool' | 'args'> & { input?: string }, e: Partial<ChatExpect>): string[] {
  const out: string[] = [];
  if (e.tool) {
    const ok = e.tool === 'read' ? CHAT_READ_TOOLS.includes(r.tool) : r.tool === e.tool;
    if (!ok) out.push(`tool: expected ${e.tool}, the model called ${r.tool}`);
  }
  const goal = r.tool === 'start_run' ? String(r.args?.goal ?? '') : null;
  for (const text of e.goalIncludes ?? []) if (goal === null || !goal.includes(text)) out.push(`goalIncludes: the goal does not contain "${text}"${goal !== null ? ` (goal: ${goal})` : ''}`);
  for (const re of e.goalMustNotInclude ?? []) if (goal !== null && new RegExp(re, 'i').test(goal)) out.push(`goalMustNotInclude: the goal matches /${re}/i (goal: ${goal})`);
  if (e.task !== undefined && (r.tool !== 'run_task' || r.args?.task !== e.task)) out.push(`task: expected run_task "${e.task}", the model called ${r.tool}${r.tool === 'run_task' ? ` "${String(r.args?.task)}"` : ''}`);
  if (e.inputs) {
    const given = Object.fromEntries(((r.args?.inputs as { name: string; value: string }[] | null | undefined) ?? []).map((i) => [i.name, i.value]));
    for (const [k, v] of Object.entries(e.inputs)) if (given[k] !== v) out.push(`inputs: expected ${k} = "${v}", got ${given[k] === undefined ? 'none' : `"${given[k]}"`}`);
  }
  if (e.options) {
    const got = r.tool === 'ask_user' ? ((r.args?.options as string[] | null | undefined) ?? []) : [];
    for (const o of e.options) if (!got.includes(o)) out.push(`options: ask_user does not offer "${o}"`);
  }
  for (const text of e.inputIncludes ?? []) if (!(r.input ?? '').includes(text)) out.push(`inputIncludes: the model's input does not contain "${text}"`);
  for (const text of e.inputMustNotInclude ?? []) if ((r.input ?? '').includes(text)) out.push(`inputMustNotInclude: the model's input contains "${text}"`);
  return out;
}

/** A scripted model: the first round trip makes the scenario's calls; any later one says a sentence. */
function scriptedAi(script: ChatScenario['script']): AiService {
  let first = true;
  const runTools = async (req: { tools: { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> }[] }) => {
    if (!first || script.length === 0) return { final: { outputText: 'Done.' }, steps: [], stopReason: 'done' };
    first = false;
    for (const [name, args] of script) {
      const t = req.tools.find((x) => x.tool.name === name);
      if (!t) throw new Error(`the script calls "${name}", which the chat does not offer (offered: ${req.tools.map((x) => x.tool.name).join(', ')})`);
      await t.execute(args, { userId: 'u' });
    }
    return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
  };
  return { forUser: () => ({ runTools }) } as unknown as AiService;
}

/** Wraps a model so every tool call it makes is recorded. */
function recordingAi(inner: AiService, calls: ChatFrontResult['calls'], aiUserId?: string, seen: { input?: string; offered?: string[] } = {}): AiService {
  return {
    forUser: (userId: string, opts: unknown) => {
      const client = (inner.forUser.bind(inner) as unknown as (u: string, o: unknown) => { runTools: (req: Record<string, unknown>) => Promise<unknown> })(aiUserId ?? userId, opts);
      return {
        ...client,
        // Bound: a real client's methods use `this`.
        runTools: (req: { input?: string; tools: { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> }[] }) => {
          if (seen.input === undefined) Object.assign(seen, { input: String(req.input ?? ''), offered: req.tools.map((t) => t.tool.name) });
          return client.runTools.call(client, {
            ...req,
            tools: req.tools.map((t) => ({
              ...t,
              execute: async (a: unknown, c: unknown) => {
                const call: ChatFrontResult['calls'][number] = { tool: t.tool.name, args: (a ?? {}) as Record<string, unknown> };
                calls.push(call);
                const out = await t.execute(a, c);
                call.output = String(out);
                return out;
              },
            })),
          });
        },
      };
    },
  } as unknown as AiService;
}

/** Web search set up and switched on for the owner (E50.7): the service's shape over the web toolset's fakes. */
function fakeWebDeps(web: NonNullable<ChatScenario['web']>) {
  const search = new FakeWebSearch();
  for (const [q, hits] of Object.entries(web.results)) search.results.set(q, hits.map((h) => ({ ...h, publishedAt: null })));
  const fetch = new FakeWebFetch();
  const webSearch = {
    system: async () => ({ enabled: true, fetch: { enabled: true } }),
    userSettings: async () => ({ enabled: true, provider: null }),
    candidates: async () => [{ provider: { id: 'fake' }, tier: null }],
    costOf: () => 0.001,
    forUser: async () => search,
  };
  return { webSearch, webFetch: { forRun: async () => fetch }, search };
}

let fakeRegistered: FakeCapabilityProvider | null = null;

/**
 * Runs one chat scenario against the app: a new owner, the chat with its accounts and conversation, the newest message, one turn. `ai` absent:
 * the scenario's script (scripted mode); given, a real model (live mode).
 */
export async function runChatScenario(app: NestFastifyApplication, scenario: ChatScenario, ai?: AiService, opts: { aiUserId?: string } = {}): Promise<ChatFrontResult> {
  const prisma = app.get(PrismaService);
  const chats = app.get(ChatService, { strict: false });
  if (!fakeRegistered) {
    fakeRegistered = new FakeCapabilityProvider('google');
    app.get(CapabilityProviderRegistry).register(fakeRegistered);
  }
  const fake = fakeRegistered;
  const user = await prisma.user.create({ data: { email: `chat-front-${randomUUID().slice(0, 8)}@example.test`, displayName: 'Person A' } });
  const adapters = app.get(ConnectionProviderRegistry);
  for (const c of scenario.connections) {
    const row = await prisma.connection.create({
      data: { userId: user.id, provider: c.provider, accountId: `acct-${randomUUID()}`, accountEmail: `${c.label.toLowerCase().replace(/\W+/g, '-')}@example.test`, label: c.label, capabilities: c.capabilities, grantedScopes: adapters.get(c.provider)?.scopesFor(c.capabilities as Capability[]) ?? c.capabilities, status: 'active' },
    });
    for (const m of c.mail) fake.account(row.id).addMessage({ from: m.from, subject: m.subject, text: m.body, date: m.date });
  }
  // The owner's saved tasks (#1007), each with its parameters as the task form stores them.
  for (const t of scenario.tasks) await prisma.task.create({ data: { userId: user.id, name: t.name, goal: t.goal, parameters: t.parameters as never } });
  // E50.17: the chat has every connection the owner switched on; it lists none.
  const chat = await chats.create(user.id, {} as never);
  for (const turn of scenario.conversation) {
    if (turn.role === 'user') await chats.postUserMessage(user.id, chat.id, turn.text);
    else if (turn.role === 'assistant') await chats.append(chat.id, { role: 'assistant', kind: 'text', text: turn.text });
    else {
      const run = await prisma.run.create({ data: { userId: user.id, conversationId: chat.id, goal: turn.goal, trigger: 'chat', origin: 'web', status: turn.status, result: turn.result, finishedAt: new Date() } });
      await chats.append(chat.id, { role: 'assistant', kind: 'run', text: turn.goal, runId: run.id });
      await chats.append(chat.id, { role: 'assistant', kind: 'result', text: turn.result, runId: run.id, meta: { status: turn.status } });
    }
  }
  // Everything before the newest message is already answered: the turn takes up only the newest one.
  const before = await prisma.chatMessage.findFirst({ where: { conversationId: chat.id }, orderBy: { seq: 'desc' }, select: { seq: true } });
  await prisma.conversation.update({ where: { id: chat.id }, data: { answeredSeq: before?.seq ?? 0 } });
  await chats.postUserMessage(user.id, chat.id, scenario.message);

  const calls: ChatFrontResult['calls'] = [];
  // Live: the model is called as the account whose AI settings the run uses (`aiUserId`); the chat itself belongs to a fresh owner.
  const seen: { input?: string; offered?: string[] } = {};
  const model = recordingAi(ai ?? scriptedAi(scenario.script), calls, ai ? opts.aiUserId : undefined, seen);
  const web = scenario.web ? fakeWebDeps(scenario.web) : null;
  // With the task starter (#1007), so run_task and the task block are what the app offers; with the batch service (E51.1), run_task_batch.
  const starter = app.get(TaskRunStarter, { strict: false });
  const turns = new ChatTurnService(prisma, chats, app.get(ChatResults, { strict: false }), app.get(TasksService, { strict: false }), app.get(JobsService, { strict: false }), model, undefined, undefined, undefined, starter, undefined, app.get(ConnectionCapabilities), web?.webSearch as never, web?.webFetch as never, app.get(RunBatchService, { strict: false }));
  let error: string | null = null;
  try {
    await turns.run(chat.id, user.id, null);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  // A batch (E51.1) waits in review: its rows, and no run started before the owner's Start.
  const batch = await prisma.runBatch.findFirst({ where: { conversationId: chat.id }, include: { items: true } });
  const batchFailures: string[] = [];
  if (scenario.expect.batchRows !== undefined) {
    if (!batch) batchFailures.push('batchRows: no batch was created');
    else {
      if (batch.status !== 'review') batchFailures.push(`batchRows: the batch is ${batch.status}, not waiting for review`);
      if (batch.items.length !== scenario.expect.batchRows) batchFailures.push(`batchRows: expected ${scenario.expect.batchRows} rows, the batch has ${batch.items.length}`);
      if ((await prisma.run.count({ where: { conversationId: chat.id } })) > 0) batchFailures.push('batchRows: a run started before the owner reviewed the batch');
    }
  }
  const runs = (await prisma.run.findMany({ where: { conversationId: chat.id, status: { in: ['queued', 'waiting_human'] } }, select: { taskId: true } }));
  const runCount = await prisma.run.count({ where: { conversationId: chat.id } });
  // The job a `start_run` or `run_task` queued is not run here: removed, so no later spec's worker picks it up (only the tool call is measured).
  await prisma.run.deleteMany({ where: { conversationId: chat.id, status: { in: ['queued', 'waiting_human'] } } });
  const first = calls[0] ?? null;
  const result: ChatFrontResult = { scenario, tool: first?.tool ?? 'none', args: first?.args ?? null, calls, runs, input: seen.input ?? '', offered: seen.offered ?? [], failures: [], pendingFailures: [], pass: false };
  result.failures = [...(error ? [`the turn failed: ${error}`] : []), ...evaluateChat(result, scenario.expect), ...batchFailures, ...(scenario.expect.noRun && runCount > 0 ? [`noRun: the turn started ${runCount} run(s)`] : [])];
  result.pendingFailures = scenario.pending ? evaluateChat(result, scenario.pending.expect).map((f) => `[pending ${scenario.pending!.issue}] ${f}`) : [];
  result.pass = result.failures.length === 0;
  return result;
}
