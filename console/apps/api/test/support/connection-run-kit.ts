// A kit for the specs of runs that use connections (E39.7): a fake fabric that counts sessions, a scripted model, a runner over the real
// database with the capability double behind the real `ConnectionCapabilities`, and the owner answering a card. Invented data only.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';

import { ApprovalRulesService } from '../../src/approvals/approval-rules.service';
import { CapabilityProviderRegistry } from '../../src/connections/capability-provider.registry';
import { ConnectionCapabilities } from '../../src/connections/connection-capabilities.service';
import { FakeCapabilityProvider } from '../../src/connections/testing';
import type { FabricClient } from '../../src/fabric/fabric.client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { QuestionEvents } from '../../src/questions/question-events';
import { QuestionsService } from '../../src/questions/questions.service';
import { GoalRunnerService } from '../../src/runner/goal-runner.service';
import { TasksService } from '../../src/tasks/tasks.service';

export type Call = [name: string, args: Record<string, unknown>];

export async function login(app: NestFastifyApplication, email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return me.json<{ data: { id: string } }>().data.id;
}

/** An in-memory fabric that counts the sessions it was asked to open and records every action. */
export function fakeFabric(opts: { failSession?: boolean; pageText?: string } = {}) {
  const actions: Record<string, unknown>[] = [];
  let sessions = 0;
  let ended = 0;
  const request = jest.fn(async (method: string, path: string, body: { body?: Record<string, unknown> } = {}) => {
    if (method === 'GET' && path === '/v1/hosts') return { hosts: [] };
    if (method === 'POST' && path === '/v1/sessions') {
      if (opts.failSession) throw new Error('no node available');
      sessions += 1;
      return { id: randomUUID() };
    }
    if (method === 'DELETE' && path.startsWith('/v1/sessions/')) return void (ended += 1);
    if (method === 'POST' && path.endsWith('/actions')) {
      const action = body.body!.action as Record<string, unknown>;
      if (action.type === 'evaluate') return { id: 'op', state: 'succeeded', result: { type: 'object', value: null } };
      actions.push(action);
      if (action.type === 'navigate') return { id: 'op', state: 'succeeded', result: { url: action.url, title: 'Page' } };
      if (action.type === 'text') return { id: 'op', state: 'succeeded', result: { text: opts.pageText ?? 'A page.' } };
      return { id: 'op', state: 'succeeded', result: {} };
    }
    throw new Error(`unexpected fabric call ${method} ${path}`);
  });
  const client = { request, config: async () => ({ url: 'http://f', token: 't' }), hosts: async () => [] } as unknown as FabricClient;
  return { client, request, actions, sessions: () => sessions, ended: () => ended };
}

/** A model that makes the scripted tool calls, one script per `runTools` call; it also records the tool names each call was offered. */
export function scriptedModel(scripts: Call[][]) {
  const outputs: string[] = [];
  const offered: string[][] = [];
  const inputs: string[] = [];
  const runTools = jest.fn(async (req: { tools: { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> }[]; onStep?: (s: unknown) => void; input: unknown; instructions?: string }) => {
    offered.push(req.tools.map((t) => t.tool.name));
    inputs.push(JSON.stringify(req.input));
    const script = scripts.shift() ?? [];
    let step = 0;
    for (const [name, args] of script) {
      const t = req.tools.find((x) => x.tool.name === name);
      if (!t) {
        outputs.push(`(not offered: ${name})`);
        continue;
      }
      outputs.push(String(await t.execute(args, { userId: 'u' })));
      req.onStep?.({ step: ++step, response: { usage: { inputTokens: 10, outputTokens: 5 } }, calls: [] });
    }
    return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
  });
  return { ai: { forUser: () => ({ runTools }) } as unknown as AiService, runTools, outputs, offered, inputs };
}

export interface Kit {
  prisma: PrismaService;
  fake: FakeCapabilityProvider;
  questions: QuestionsService;
  approvals: ApprovalRulesService;
  enqueued: unknown[];
  /** The runner with the given model and fabric; `connections` and the approvals are the real services over the capability double. */
  runner(model: ReturnType<typeof scriptedModel>, fabric: ReturnType<typeof fakeFabric>): GoalRunnerService;
  /** A connection row of the user with the switches on. */
  connect(userId: string, label: string, capabilities: string[], extra?: { email?: string; defaultFor?: string[]; status?: 'active' | 'paused' | 'needs_reconnect' }): Promise<{ id: string; label: string }>;
  /** The owner answers the card the run waits on. */
  answer(userId: string, runId: string, input: Record<string, unknown>, channel?: string): Promise<unknown>;
}

export function connectionKit(app: NestFastifyApplication): Kit {
  const prisma = app.get(PrismaService);
  const fake = new FakeCapabilityProvider('google');
  app.get(CapabilityProviderRegistry).register(fake);
  const enqueued: unknown[] = [];
  const approvals = app.get(ApprovalRulesService);
  const questions = new QuestionsService(prisma, { request: async () => ({}) } as never, { enqueue: async (j: unknown) => void enqueued.push(j) } as never, new QuestionEvents(), undefined, undefined, approvals);
  const hub = app.get(ConnectionCapabilities);
  return {
    prisma,
    fake,
    questions,
    approvals,
    enqueued,
    runner(model, fabric) {
      const notifier = { needsYou: async () => undefined, finished: async () => undefined, started: async () => undefined, savedApprovalsUsed: async () => undefined };
      const runner = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, model.ai, notifier as never, questions);
      runner.approvals = approvals;
      runner.connections = hub;
      return runner;
    },
    async connect(userId, label, capabilities, extra = {}) {
      const row = await prisma.connection.create({
        data: { userId, provider: 'google', accountId: `acct-${randomUUID()}`, accountEmail: extra.email ?? `${label.toLowerCase().replace(/\W+/g, '-')}@example.test`, label, capabilities, grantedScopes: capabilities, defaultFor: extra.defaultFor ?? [], status: extra.status ?? 'active' },
      });
      return { id: row.id, label: row.label };
    },
    async answer(userId, runId, input, channel = 'web') {
      return questions.answerRun({ id: userId }, runId, input as never, { channel });
    },
  };
}
