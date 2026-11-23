// The kit of the E46 phase 5 acceptance scenarios (#856): the application over the real database, signed-in owners, the switches, a
// scripted model that records what each round read and was offered, and a runner with the Knowledge Graph bound exactly as the
// application binds it. Not a spec: the scenarios in this folder import it. Invented data only.
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';
import { OAuthServerSettingsReader, PatService } from '@marinoscar/platform-api/identity';
import { createOAuthTestClient, mintOAuthTestToken } from '@marinoscar/platform-api/identity/testing';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

import { KgraphAfterRun } from '../../../src/kgraph/kgraph-compile.job';
import { KgraphEnabledService } from '../../../src/kgraph/kgraph-enabled.service';
import { PrismaProcedureStore } from '../../../src/kgraph/prisma-procedure-store';
import { KgraphSiteFactsHandler } from '../../../src/kgraph/site-facts.job';
import { KgraphSiteFactsService } from '../../../src/kgraph/site-facts.service';
import { createApp } from '../../../src/main';
import { MemoryContext } from '../../../src/memories/memory-context';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { QuestionEvents } from '../../../src/questions/question-events';
import { QuestionsService } from '../../../src/questions/questions.service';
import { GoalRunnerService } from '../../../src/runner/goal-runner.service';
import { TasksService } from '../../../src/tasks/tasks.service';
import { fakeSecretsFabric, type SecretsFabric } from '../../support/fake-secrets-fabric';

export type Session = { userId: string; token: string };
export type Call = [name: string, args: Record<string, unknown>];
type Tool = { tool: { name: string; description: string; parameters: z.ZodType }; execute: (a: unknown, c: unknown) => Promise<unknown> };
export interface Round {
  tools: { name: string; description: string; parameters: z.ZodType }[];
  instructions: string;
  /** The round's input as JSON text. */
  input: string;
  /** What each scripted call answered, in order. */
  outputs: string[];
}

/** Starts the application with the job worker off (the specs run the jobs' work directly). */
export async function startApp(): Promise<{ app: NestFastifyApplication; prisma: PrismaService }> {
  const workerMode = process.env.JOBS_WORKER_MODE;
  process.env.JOBS_WORKER_MODE = 'off';
  const app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
  return { app, prisma: app.get(PrismaService) };
}

/** A signed-in browser session (the test login issues a session token, as the console's sign-in does). */
export async function login(app: NestFastifyApplication, email: string, role: 'contributor' | 'admin' = 'contributor'): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { userId: me.json<{ data: { id: string } }>().data.id, token };
}

export function api(app: NestFastifyApplication) {
  return (token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => app.inject({ method, url: `/api${url}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
}

/** The owner's opt-in auto-approve of derived facts (`kgraph.autoApproveFacts`, E46.36), with everyday as given. */
export async function autoApprove(app: NestFastifyApplication, owner: Session, everyday: boolean, autoApproveFacts: boolean): Promise<void> {
  expect((await api(app)(owner.token, 'PATCH', '/user-settings', { kgraph: { enabled: true, everyday, autoApproveFacts } })).statusCode).toBeLessThan(300);
}

/** The three levels of switches: the deployment's, the owner's and the owner's everyday switch (`null`: never set). */
export async function switches(app: NestFastifyApplication, admin: Session, owner: Session, deployment: boolean, user: boolean, everyday: boolean | null): Promise<void> {
  const call = api(app);
  expect((await call(admin.token, 'PATCH', '/system-settings', { kgraph: { enabled: deployment, pacing: 'fast' } })).statusCode).toBeLessThan(300);
  expect((await call(owner.token, 'PATCH', '/user-settings', { kgraph: everyday === null ? { enabled: user } : { enabled: user, everyday } })).statusCode).toBeLessThan(300);
}

/** A model that makes the scripted tool calls, one script per `runTools` call, and records each round. */
export function scriptedAi(scripts: Call[][]) {
  const rounds: Round[] = [];
  const runTools = jest.fn(async (req: { tools: Tool[]; instructions: string; input: unknown; onStep?: (s: unknown) => void }) => {
    const round: Round = { tools: req.tools.map((t) => t.tool), instructions: req.instructions, input: typeof req.input === 'string' ? req.input : JSON.stringify(req.input), outputs: [] };
    rounds.push(round);
    let step = 0;
    for (const [name, args] of scripts.shift() ?? []) {
      const t = req.tools.find((x) => x.tool.name === name);
      round.outputs.push(t ? String(await t.execute(args, { userId: 'u' })) : `(not offered: ${name})`);
      req.onStep?.({ step: ++step, response: { usage: { inputTokens: 10, outputTokens: 5 } }, calls: [] });
    }
    return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
  });
  return { ai: { forUser: () => ({ runTools }) } as unknown as AiService, runTools, rounds };
}

export const notifier = { finished: jest.fn(), needsYou: jest.fn(), started: jest.fn(), savedLoginUsed: jest.fn(), savedApprovalsUsed: jest.fn(), overBudget: jest.fn() };

/**
 * The runner as the application builds it, with the memories bound. `kgraph`: bind the Knowledge Graph (the switch service, the after-run
 * hook, the procedure store and the site facts service); false is a runner with no Knowledge Graph at all, the baseline of "off".
 */
export function runnerOf(app: NestFastifyApplication, fabric: SecretsFabric, ai: AiService, kgraph = true): GoalRunnerService {
  const prisma = app.get(PrismaService);
  const questions = new QuestionsService(prisma, fabric.client, { enqueue: async () => undefined } as never, new QuestionEvents());
  const r = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, notifier as never, questions, undefined, undefined, undefined, undefined, undefined, app.get(MemoryContext, { strict: false }));
  if (kgraph) bindKgraph(app, r);
  return r;
}

/** Binds the Knowledge Graph on a runner built elsewhere (the connection kit's). */
export function bindKgraph(app: NestFastifyApplication, r: GoalRunnerService): GoalRunnerService {
  r.kgraph = app.get(KgraphEnabledService);
  r.kgraphAfterRun = app.get(KgraphAfterRun);
  r.kgraphStore = app.get(PrismaProcedureStore);
  r.kgraphSiteFacts = app.get(KgraphSiteFactsService);
  return r;
}

/** The fake fabric on `url`, with a search form, and navigation that moves the page. */
export function fabricAt(url = 'https://shop.example.test/start'): SecretsFabric {
  const fabric = fakeSecretsFabric(url);
  fabric.page.inputs = [{ selector: '#q', tag: 'input' }, { selector: '#go', tag: 'button' }];
  const original = fabric.request.getMockImplementation()!;
  fabric.request.mockImplementation(async (method: string, path: string, opts: { body?: Record<string, unknown> } = {}) => {
    const action = opts.body?.action as { type?: string; url?: string } | undefined;
    if (method === 'POST' && path.endsWith('/actions') && action?.type === 'navigate') {
      fabric.actions.push(action as Record<string, unknown>);
      fabric.page.url = String(action.url);
      return { id: 'op', state: 'succeeded', result: { url: fabric.page.url, title: '' } } as never;
    }
    return original(method, path, opts);
  });
  return fabric;
}

/** A chat run (trigger `chat`, in a conversation) or, with `oneOff`, a run with no task and no chat. */
export async function chatRun(prisma: PrismaService, owner: Session, goal: string, allowedDomains: string[]): Promise<{ runId: string; chatId: string }> {
  const db = prisma.forUser({ userId: owner.userId });
  const c = await db.conversation.create({ data: { userId: owner.userId, title: 'Chat', allowedDomains, confirmRiskyActions: false } });
  const run = await db.run.create({ data: { userId: owner.userId, conversationId: c.id, trigger: 'chat', goal } });
  return { runId: run.id, chatId: c.id };
}

/** A saved task in a Knowledge Graph mode, and a queued run of it. */
export async function taskRun(prisma: PrismaService, owner: Session, mode: 'off' | 'learn' | 'reuse', goal: string, allowedDomains: string[], name = goal): Promise<{ taskId: string; runId: string }> {
  const db = prisma.forUser({ userId: owner.userId });
  const t = await db.task.create({ data: { userId: owner.userId, name, goal, confirmRiskyActions: false, allowedDomains } });
  await prisma.kgTaskSettings.create({ data: { taskId: t.id, userId: owner.userId, mode } });
  const run = await db.run.create({ data: { userId: owner.userId, taskId: t.id, goal } });
  return { taskId: t.id, runId: run.id };
}

/** An active fact the owner typed (the route, so it goes through the same rules as the console's Sites tab). */
export async function ownerFact(app: NestFastifyApplication, owner: Session, site: string, kind: string, text: string): Promise<string> {
  const res = await api(app)(owner.token, 'POST', `/kgraph/sites/${site}/facts`, { kind, text });
  expect(res.statusCode).toBe(201);
  const fact = res.json<{ data: { id: string; status: string } }>().data;
  expect(fact.status).toBe('active');
  return fact.id;
}

/** The round input with the run's own ids taken out (they differ between two runs by construction). */
export const withoutIds = (input: string, ...ids: string[]) => ids.reduce((s, id) => s.split(id).join('<id>'), input);

/** A tool's schema, for comparing what two rounds were offered. */
export const schemaOf = (t: Round['tools'][number]) => ({ name: t.name, description: t.description, parameters: z.toJSONSchema(t.parameters) });

export const SITE_FACTS_BLOCK = 'About these sites (';
export const PROCEDURES_BLOCK = 'Saved procedures that may fit';

export type McpResult = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> };

/**
 * A hosted MCP client (E46.39): an OAuth app registered on a test host, with the OAuth server on; `token(userId, scopes)` mints an access
 * token as the consent screen would; `pat(userId)` a personal access token. `rpc` and `call` speak JSON-RPC to `POST /api/mcp`.
 */
export async function hostedClient(app: NestFastifyApplication, admin: Session) {
  const prisma = app.get(PrismaService);
  const host = `kg-scenario-${randomUUID().slice(0, 8)}.example.test`;
  const appUrl = app.get(ConfigService).get<string>('appUrl')!.replace(/\/+$/, '');
  const client = await createOAuthTestClient(prisma as never, { name: 'Scripted assistant', redirectUris: [`https://${host}/callback`], host, tokenEndpointAuthMethod: 'none' });
  await app.get(SystemSettingsService).patchSettings({ oauthServer: { enabled: true, allowedClientHosts: [host], allowAnyClientHost: false } } as never, admin.userId);
  app.get(OAuthServerSettingsReader).invalidate();
  const rpc = async (token: string, body: unknown) => {
    const res = await app.inject({ method: 'POST', url: '/api/mcp', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, payload: JSON.stringify(body) });
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
  };
  return {
    client,
    appUrl,
    rpc,
    names: async (token: string) => ((await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json.result.tools as Array<{ name: string }>).map((t) => t.name),
    call: async (token: string, name: string, args: Record<string, unknown> = {}) => {
      const r = await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
      return { status: r.status, result: r.json?.result as McpResult };
    },
    token: async (userId: string, scopes: readonly string[]) => {
      await prisma.oAuthGrant.updateMany({ where: { userId, clientId: client.id, revokedAt: null }, data: { revokedAt: new Date() } });
      return (await mintOAuthTestToken(prisma as never, { userId, resourceId: 'mcp', scopes, appUrl, client: { id: client.id } })).token;
    },
    pat: async (userId: string) => (await app.get(PatService).createToken(userId, { name: `kgs-${randomUUID().slice(0, 6)}`, durationValue: 1, durationUnit: 'days' } as never)).token,
    close: async () => {
      await app.get(SystemSettingsService).patchSettings({ oauthServer: { enabled: false, allowedClientHosts: [] } } as never, admin.userId);
      await prisma.oAuthClient.deleteMany({ where: { id: client.id } });
    },
  };
}

export const PORTAL = 'portal.example.test';
const link = (id: string, name: string) => ({ selector: `#${id}`, selectors: [`#${id}`, `nav a[data-nav="${id}"]`], role: 'link', name, tag: 'a', inputType: null, anchor: 'Main menu' });
const ASK_CODE: Call = ['request_human', { kind: 'code', prompt: 'Enter the code', input: 'secret', choices: null, options: null, constraints: null, confirm_label: null, deny_label: null, risk: null, remember_label: null, topic: null }];

/**
 * An everyday chat on the portal (E46.39, after E46.36's spec): open it, click three links (`labels`), ask the owner for a one-time code
 * and type it, run `extra` (say a `propose_site_fact`), finish. The invoices click is recorded as slow (9.4 s), so the derive step has a
 * navigation, a sign-in and a timing fact to propose. Returns the run and what the second round's calls answered.
 */
export async function derivingChat(app: NestFastifyApplication, owner: Session, labels: [string, string, string] = ['Billing', 'History', 'Invoices'], extra: Call[] = []) {
  const prisma = app.get(PrismaService);
  const db = prisma.forUser({ userId: owner.userId });
  const c = await db.conversation.create({ data: { userId: owner.userId, title: 'Chat', allowedDomains: [PORTAL], confirmRiskyActions: false } });
  const runId = (await db.run.create({ data: { userId: owner.userId, conversationId: c.id, trigger: 'chat', goal: `Download the latest invoice from ${PORTAL}` } })).id;
  const fabric = fakeSecretsFabric(`https://${PORTAL}/start`);
  fabric.page.inputs = [{ selector: '#otp', tag: 'input' }];
  fabric.surface.push(link('billing', labels[0]), link('history', labels[1]), link('invoices', labels[2]));
  const first = scriptedAi([
    [['navigate', { url: `https://${PORTAL}/`, reason: 'open the portal' }], ['click', { selector: '#billing', reason: 'billing' }], ['click', { selector: '#history', reason: 'history' }], ['click', { selector: '#invoices', reason: 'invoices' }], ASK_CODE],
  ]);
  const outcomes = [await runnerOf(app, fabric, first.ai).advance(runId, owner.userId, null)];
  const code = [...fabric.handoffs.values()][0];
  if (code) {
    fabric.answer(code, { value_withheld: true });
    Object.assign(code, { secret: 'otp-493817-zz' });
  }
  const second = scriptedAi([[['type_handoff_secret', { selector: '#otp', submit: true, parameter: null }], ...extra, ['finish', { success: true, result: 'Downloaded.' }]]]);
  outcomes.push(await runnerOf(app, fabric, second.ai).advance(runId, owner.userId, null));
  const slow = await prisma.runStep.findFirstOrThrow({ where: { runId, action: 'click' }, orderBy: { seq: 'desc' } });
  await prisma.runStep.update({ where: { id: slow.id }, data: { durationMs: 9_400 } });
  return { runId, outcomes, outputs: second.rounds[0]?.outputs ?? [] };
}

/** The `kgraph.site_facts` job's work for one run, run directly (the job worker is off in the scenarios). */
export const deriveFacts = (app: NestFastifyApplication, owner: Session, runId: string) => app.get(KgraphSiteFactsHandler).process({ id: `job-${runId}`, payload: { userId: owner.userId, runId } } as never);
