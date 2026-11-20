// Characterisation of the goal runner (E38.5, #586): what the agent does, pinned at the boundary so the runner can be split without
// changing it. Scripted runs against a real database and an in-memory fabric record, as snapshots:
//   (a) the tool names, descriptions and JSON schemas offered to the model, per configuration,
//   (b) the exact model input text of each round (images shortened to a marker),
//   (c) the fabric actions sent,
//   (d) the run_steps rows,
//   (e) the final run row.
// The snapshots in __snapshots__/runner-characterisation.db.spec.ts.snap are committed before the split and must be byte-identical
// after it. A deliberate change to a prompt, a tool or a step text is NOT allowed in a refactor: fix the code, not the snapshot.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';
import { z } from 'zod';

import { createApp } from '../src/main';
import { balancedSpec } from '../src/policies/builtin-policies';
import { PrismaService } from '../src/prisma/prisma.service';
import { QuestionEvents } from '../src/questions/question-events';
import { QuestionsService } from '../src/questions/questions.service';
import { GoalRunnerService } from '../src/runner/goal-runner.service';
import { RunSecretsService } from '../src/secrets/run-secrets.service';
import { TasksService } from '../src/tasks/tasks.service';
import { fakeSecretsFabric, FIXTURE, type SecretsFabric } from './support/fake-secrets-fabric';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app?.close();
});

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return me.json<{ data: { id: string } }>().data.id;
}

type Call = [name: string, args: Record<string, unknown>];
type Tool = { tool: { name: string; description?: string; parameters?: unknown; strict?: boolean }; execute: (a: unknown, c: unknown) => Promise<unknown> };
type Req = { tools: Tool[]; onStep?: (s: unknown) => void; input: unknown; instructions?: string; [k: string]: unknown };

/** A model that makes the scripted tool calls, one script per round; it keeps what each round was given and what each tool answered. */
function scriptedAi(scripts: Call[][]) {
  const rounds: { request: Record<string, unknown>; tools: unknown[]; input: unknown; outputs: string[] }[] = [];
  const runTools = jest.fn(async (req: Req) => {
    const { tools, onStep, input, instructions, ...rest } = req;
    // The JSON schema the model is offered for each tool (the zod object itself is an implementation detail).
    const offered = tools.map((t) => ({ name: t.tool.name, description: t.tool.description, strict: t.tool.strict, parameters: z.toJSONSchema(t.tool.parameters as z.ZodType) }));
    const round = { request: { ...rest, instructions }, tools: offered, input, outputs: [] as string[] };
    rounds.push(round);
    let step = 0;
    for (const [name, args] of scripts.shift() ?? []) {
      const t = tools.find((x) => x.tool.name === name);
      if (!t) {
        round.outputs.push(`NO TOOL ${name}`);
        continue;
      }
      round.outputs.push(String(await t.execute(args, { userId: 'u' })));
      onStep?.({ step: ++step, response: { usage: { inputTokens: 10, outputTokens: 5 } }, calls: [] });
    }
    return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
  });
  return { ai: { forUser: () => ({ runTools }) } as unknown as AiService, rounds };
}

const notifier = { finished: jest.fn(), needsYou: jest.fn(), started: jest.fn(), savedLoginUsed: jest.fn(), savedApprovalsUsed: jest.fn(), overBudget: jest.fn() };

function seamOf(opts: { identity?: boolean; cards?: boolean; saveLogin?: boolean } = {}) {
  return {
    prepare: async () => 'registered',
    outcome: async () => undefined,
    identitySupported: async () => opts.identity ?? false,
    cardsSupported: async () => opts.cards ?? false,
    saveLoginSupported: async () => opts.saveLogin ?? false,
    providerAddress: async () => 'https://vault.example.test',
    proposeSaveLogin: async () => ({ message: 'offered' }),
  } as unknown as RunSecretsService;
}

function runnerOf(fabric: SecretsFabric, ai: AiService, extra: { secrets?: RunSecretsService; proposals?: unknown } = {}) {
  const questions = new QuestionsService(prisma, fabric.client, { enqueue: async () => undefined } as never, new QuestionEvents());
  const r = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, notifier as never, questions);
  if (extra.secrets) r.secrets = extra.secrets;
  if (extra.proposals) (r as unknown as { proposals: unknown }).proposals = extra.proposals;
  return r;
}

/** Ids, timestamps and the random handoff ids are not part of the behaviour. */
function scrub<T>(value: T): T {
  const text = JSON.stringify(value)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<time>')
    .replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g, '<image>');
  return JSON.parse(text) as T;
}

async function record(runId: string, rounds: ReturnType<typeof scriptedAi>['rounds'], fabric: SecretsFabric, outcomes: string[]) {
  const steps = await prisma.runStep.findMany({ where: { runId }, orderBy: { seq: 'asc' } });
  const run = await prisma.run.findFirstOrThrow({ where: { id: runId } });
  const pick = ({ id: _id, runId: _r, createdAt: _c, startedAt: _s, ...s }: Record<string, unknown>) => ({ ...s, durationMs: typeof s.durationMs === 'number' ? 'ms' : s.durationMs });
  return scrub({
    outcomes,
    // A round's tool list is listed once, and again only when it differs from the round before.
    rounds: rounds.map((r, i) => ({ request: i > 0 && rounds[i - 1]!.request.instructions === r.request.instructions ? { ...r.request, instructions: 'same instructions' } : r.request, tools: i > 0 && JSON.stringify(rounds[i - 1]!.tools) === JSON.stringify(r.tools) ? 'same tools' : r.tools, input: r.input, outputs: r.outputs })),
    actions: fabric.actions,
    steps: steps.map((s) => pick(s as unknown as Record<string, unknown>)),
    run: {
      status: run.status,
      stopReason: run.stopReason,
      result: run.result,
      error: run.error,
      stepCount: run.stepCount,
      modelCalls: run.modelCalls,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      currentTier: run.currentTier,
      escalations: run.escalations,
      handoffId: run.handoffId,
      activity: run.activity,
      transcript: run.transcript,
      confirmedActions: run.confirmedActions,
      usedSavedLogins: run.usedSavedLogins,
      usedSavedIdentity: run.usedSavedIdentity,
      memoryIds: run.memoryIds,
    },
  });
}

const finish = (result = 'Done.', success = true): Call => ['finish', { success, result }];

describe('goal runner characterisation (E38.5)', () => {
  it('offers every tool, one of each is called, and the whole run is pinned', async () => {
    const userId = await login(`char-all-${stamp}@example.test`);
    const db = prisma.forUser({ userId });
    const run = await db.run.create({ data: { userId, goal: 'Check every control of the page' } });
    const fabric = fakeSecretsFabric('https://shop.example.test/start');
    fabric.state.screenshots = true;
    fabric.page.inputs = [
      { selector: '#q', tag: 'input' },
      { selector: '#go', tag: 'button' },
    ];
    const s = scriptedAi([
      // Round 1: every action tool once; `look` ends the round and the next one starts with the picture.
      [
        ['observe_elements', {}],
        ['read_text', { selector: null }],
        ['read_text', { selector: '#q' }],
        ['navigate', { url: 'https://shop.example.test/item?ref=abc', reason: 'open the shop' }],
        ['click', { selector: '#go', reason: 'search' }],
        ['type_text', { selector: '#q', text: 'blue pens', submit: false }],
        ['press_key', { key: 'Enter' }],
        ['scroll', { dy: 400 }],
        ['wait_for', { selector: '#results' }],
        ['go_back', {}],
        ['click_mark', { n: 2, double: false, reason: 'the go button' }],
        ['click_mark', { n: 9, double: false, reason: 'no such mark' }],
        ['click_at', { x: 10, y: 20, button: 'left', double: false, modifiers: [], reason: 'canvas' }],
        ['click_at', { x: 11, y: 21, button: 'right', double: true, modifiers: ['ctrl'], reason: 'context menu' }],
        ['hover_at', { x: 30, y: 40 }],
        ['drag', { from_x: 1, from_y: 2, to_x: 3, to_y: 4 }],
        ['scroll_at', { x: 5, y: 6, dy: -200 }],
        ['type_keys', { text: 'hello' }],
        ['key', { key: 'a', modifiers: ['ctrl'] }],
        ['run_javascript', { script: 'document.title', reason: 'read the title' }],
        ['tabs', {}],
        ['switch_tab', { tab_id: 1 }],
        ['new_tab', { url: 'https://shop.example.test/cart' }],
        ['new_tab', { url: null }],
        ['desktop_click', { x: 1, y: 1, button: 'left', double: false }],
        ['desktop_type', { text: 'file.txt' }],
        ['desktop_key', { key: 'Return' }],
        ['desktop_scroll', { x: 9, y: 9, dy: 3 }],
        ['desktop_drag', { from_x: 1, from_y: 1, to_x: 2, to_y: 2 }],
        ['look', { screen: 'page', reason: 'see the result' }],
      ],
      [['look', { screen: 'desktop', reason: 'a native dialog' }]],
      [['request_human', { kind: 'other', prompt: 'Which size?', input: 'choice', choices: ['S', 'M'], options: null, constraints: null, confirm_label: null, deny_label: null, risk: null, remember_label: null, topic: null }]],
    ]);
    const runner = runnerOf(fabric, s.ai);
    const outcomes = [await runner.advance(run.id, userId, null)];
    // The owner answers the choice; the run resumes and finishes.
    const h = [...fabric.handoffs.values()][0]!;
    fabric.answer(h, { value: 'M' });
    const s2 = scriptedAi([[finish('Checked every control.')]]);
    const runner2 = runnerOf(fabric, s2.ai);
    outcomes.push(await runner2.advance(run.id, userId, null));
    expect(await record(run.id, [...s.rounds, ...s2.rounds], fabric, outcomes)).toMatchSnapshot();
  });

  it('pins the refusals: a site outside the allowed list, a gated click, a confirmation and a typed secret', async () => {
    const userId = await login(`char-gate-${stamp}@example.test`);
    const db = prisma.forUser({ userId });
    const chat = await db.conversation.create({ data: { userId, title: 'Order', allowedDomains: ['shop.example.test'] } });
    const run = await db.run.create({ data: { userId, conversationId: chat.id, trigger: 'chat', goal: 'Buy the item' } });
    const fabric = fakeSecretsFabric('https://shop.example.test/checkout');
    fabric.targets.set('#pay', { tag: 'button', label: 'Pay now', role: null });
    fabric.state.screenshots = true;
    const first = scriptedAi([
      [
        ['navigate', { url: 'https://shop.example.test/item', reason: 'open the shop' }],
        ['navigate', { url: 'https://elsewhere.example.test/', reason: 'detour' }],
        ['navigate', { url: 'javascript:alert(1)', reason: 'script' }],
        ['new_tab', { url: 'https://elsewhere.example.test/' }],
        ['click', { selector: '#pay', reason: 'pay' }],
        ['request_human', { kind: 'confirmation', prompt: 'Pay 10 USD at the shop?', input: 'confirm', choices: null, options: null, constraints: null, confirm_label: 'Pay', deny_label: 'Not now', risk: 'high', remember_label: null, topic: 'purchase' }],
      ],
    ]);
    const outcomes = [await runnerOf(fabric, first.ai).advance(run.id, userId, null)];
    // The owner approves; the same click now goes through, then a code is asked for and typed.
    fabric.answer([...fabric.handoffs.values()][0]!, { value: 'approve' });
    const second = scriptedAi([
      [
        ['click', { selector: '#pay', reason: 'pay again' }],
        ['request_human', { kind: 'code', prompt: 'Enter the code', input: 'secret', choices: null, options: null, constraints: null, confirm_label: null, deny_label: null, risk: null, remember_label: null, topic: null }],
      ],
    ]);
    outcomes.push(await runnerOf(fabric, second.ai).advance(run.id, userId, null));
    const code = [...fabric.handoffs.values()][1]!;
    fabric.answer(code, { value_withheld: true });
    Object.assign(code, { secret: 'otp-424242-zz' });
    const third = scriptedAi([[['type_handoff_secret', { selector: '#otp', submit: true, parameter: null }], ['type_handoff_secret', { selector: '#otp', submit: true, parameter: null }], finish('Paid.')]]);
    outcomes.push(await runnerOf(fabric, third.ai).advance(run.id, userId, null));
    const snap = await record(run.id, [...first.rounds, ...second.rounds, ...third.rounds], fabric, outcomes);
    expect(JSON.stringify(snap)).not.toContain('otp-424242-zz');
    expect(snap).toMatchSnapshot();
  });

  it('pins the saved login and saved identity tools, and the tool list with every switch on', async () => {
    const userId = await login(`char-secrets-${stamp}@example.test`);
    const db = prisma.forUser({ userId });
    const task = await db.task.create({ data: { userId, name: 'Apply', goal: 'Fill the form', useSavedLogins: true, useSavedIdentity: true, useSavedCards: true, confirmRiskyActions: false } });
    const run = await db.run.create({ data: { userId, taskId: task.id, goal: 'Fill the form' } });
    const fabric = fakeSecretsFabric(`${FIXTURE.origin}/signin`);
    fabric.state.screenshots = true;
    fabric.page.inputs = [
      { selector: '#user', tag: 'input' },
      { selector: '#pw', tag: 'input' },
      { selector: '#name', tag: 'input' },
    ];
    const proposals = { propose: async () => ({ message: 'proposed' }) };
    const s = scriptedAi([
      [
        ['saved_logins', {}],
        ['sign_in_with_saved_login', { ref: 'login-1', username_selector: '#user', password_selector: '#pw', submit: true }],
        ['type_saved_code', { ref: 'login-1', selector: '#code', submit: false }],
        ['saved_identity', {}],
        ['fill_from_identity', { ref: 'details-1', field: 'full_name', selector: '#name', part: null }],
        ['read_text', { selector: '#name' }],
        ['observe_elements', {}],
        ['run_javascript', { script: "document.querySelector('#name').value", reason: 'read it back' }],
        ['look', { screen: 'page', reason: 'check' }],
      ],
      [['propose_memory', { kind: 'preference', label: 'Seat', aliases: null, attributes: [{ name: 'seat', value: 'aisle' }], supersedes: null, from_answer: false }], finish('Filled.')],
    ]);
    const runner = runnerOf(fabric, s.ai, { secrets: seamOf({ identity: true, cards: true, saveLogin: true }), proposals });
    const outcomes = [await runner.advance(run.id, userId, null)];
    expect(await record(run.id, s.rounds, fabric, outcomes)).toMatchSnapshot();
  });

  it('pins a budget that ends a run: the wrap-up call with only finish', async () => {
    const userId = await login(`char-budget-${stamp}@example.test`);
    const db = prisma.forUser({ userId });
    const run = await db.run.create({ data: { userId, goal: 'Never finishes' } });
    const fabric = fakeSecretsFabric('https://shop.example.test/start');
    // The default policy allows far more than this; the snapshot's budget is lowered to two actions.
    const spec = balancedSpec();
    const snapshot = { schemaVersion: 1, ref: 'char', name: 'Char', version: 1, builtin: false, source: 'system_default', spec: { ...spec, budget: { ...spec.budget, actions: 2 } }, tiers: null, takenAt: '2026-11-19T00:00:00.000Z' };
    await db.run.update({ where: { id: run.id }, data: { policySnapshot: snapshot as never } });
    const s = scriptedAi([
      [
        ['navigate', { url: 'https://shop.example.test/a', reason: 'one' }],
        ['navigate', { url: 'https://shop.example.test/b', reason: 'two' }],
        ['navigate', { url: 'https://shop.example.test/c', reason: 'three' }],
      ],
      [finish('Stopped at the limit.', false)],
    ]);
    const outcomes = [await runnerOf(fabric, s.ai).advance(run.id, userId, null)];
    expect(await record(run.id, s.rounds, fabric, outcomes)).toMatchSnapshot();
  });
});
