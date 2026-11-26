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
import { TasksService } from '../../src/tasks/tasks.service';

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
});

export const chatScenarioSchema = z.strictObject({
  $schema: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  connections: z
    .array(z.strictObject({ label: z.string().min(1), provider: z.enum(['google', 'microsoft']).default('google'), access: z.enum(['read', 'read_write']).default('read_write'), capabilities: z.array(z.string()).min(1), mail: z.array(z.strictObject({ from: z.string(), subject: z.string(), body: z.string(), date: z.string() })).default([]) }))
    .default([]),
  conversation: z.array(turnSchema).default([]),
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
  calls: { tool: string; args: Record<string, unknown> }[];
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
export function evaluateChat(r: Pick<ChatFrontResult, 'tool' | 'args'>, e: Partial<ChatExpect>): string[] {
  const out: string[] = [];
  if (e.tool) {
    const ok = e.tool === 'read' ? CHAT_READ_TOOLS.includes(r.tool) : r.tool === e.tool;
    if (!ok) out.push(`tool: expected ${e.tool}, the model called ${r.tool}`);
  }
  const goal = r.tool === 'start_run' ? String(r.args?.goal ?? '') : null;
  for (const text of e.goalIncludes ?? []) if (goal === null || !goal.includes(text)) out.push(`goalIncludes: the goal does not contain "${text}"${goal !== null ? ` (goal: ${goal})` : ''}`);
  for (const re of e.goalMustNotInclude ?? []) if (goal !== null && new RegExp(re, 'i').test(goal)) out.push(`goalMustNotInclude: the goal matches /${re}/i (goal: ${goal})`);
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
function recordingAi(inner: AiService, calls: ChatFrontResult['calls'], aiUserId?: string): AiService {
  return {
    forUser: (userId: string, opts: unknown) => {
      const client = (inner.forUser.bind(inner) as unknown as (u: string, o: unknown) => { runTools: (req: Record<string, unknown>) => Promise<unknown> })(aiUserId ?? userId, opts);
      return {
        ...client,
        // Bound: a real client's methods use `this`.
        runTools: (req: { tools: { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> }[] }) =>
          client.runTools.call(client, {
            ...req,
            tools: req.tools.map((t) => ({ ...t, execute: (a: unknown, c: unknown) => (calls.push({ tool: t.tool.name, args: (a ?? {}) as Record<string, unknown> }), t.execute(a, c)) })),
          }),
      };
    },
  } as unknown as AiService;
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
  const model = recordingAi(ai ?? scriptedAi(scenario.script), calls, ai ? opts.aiUserId : undefined);
  const turns = new ChatTurnService(prisma, chats, app.get(ChatResults, { strict: false }), app.get(TasksService, { strict: false }), app.get(JobsService, { strict: false }), model, undefined, undefined, undefined, undefined, undefined, app.get(ConnectionCapabilities));
  let error: string | null = null;
  try {
    await turns.run(chat.id, user.id, null);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  // The job a `start_run` queued is not run here: removed, so no later spec's worker picks it up (only the tool call is measured).
  await prisma.run.deleteMany({ where: { conversationId: chat.id, status: 'queued' } });
  const first = calls[0] ?? null;
  const result: ChatFrontResult = { scenario, tool: first?.tool ?? 'none', args: first?.args ?? null, calls, failures: [], pendingFailures: [], pass: false };
  result.failures = [...(error ? [`the turn failed: ${error}`] : []), ...evaluateChat(result, scenario.expect)];
  result.pendingFailures = scenario.pending ? evaluateChat(result, scenario.pending.expect).map((f) => `[pending ${scenario.pending!.issue}] ${f}`) : [];
  result.pass = result.failures.length === 0;
  return result;
}
