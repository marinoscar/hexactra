// Identity details the agent fills without seeing them (E37.6, #595) against a real database: a scripted model, the in-memory
// fabric of test/support/fake-secrets-fabric.ts (the `test` provider with its identity item) and the real question broker.
//
// What this proves: the tools are offered only with every switch; a scripted form (a name, a date of birth in three selects and
// an ID number) is filled with no value in any step, tool result, question, memory or model input; a detail this site may not
// have asks the owner through a card with two choices; what the fabric filled is never read back (elements, text, scripts and
// screenshots), for a saved login's password too; a task parameter defaulted from a saved field is filled, not asked.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { QuestionEvents } from '../src/questions/question-events';
import { QuestionsService } from '../src/questions/questions.service';
import { TaskRunStarter } from '../src/questions/task-run-starter';
import { GoalRunnerService } from '../src/runner/goal-runner.service';
import { RunSecretsService } from '../src/secrets/run-secrets.service';
import { TaskSchedulesService } from '../src/tasks/task-schedules.service';
import { TasksService } from '../src/tasks/tasks.service';
import { FIXTURE, IDENTITY, fakeSecretsFabric, type SecretsFabric } from './support/fake-secrets-fabric';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;
/** The identity item's allowed origin (its sensitive fields may be typed here) and a site that is not on its list. */
const ALLOWED_PAGE = `${FIXTURE.origin}/apply`;
const OTHER_PAGE = 'https://other.example.test/apply';
const MARKER = '[filled from your saved details]';

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await app?.close();
});

async function login(email: string): Promise<{ userId: string; token: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { userId: me.json<{ data: { id: string } }>().data.id, token };
}

type Call = [name: string, args: Record<string, unknown>];
type Tools = { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> }[];

/** A model that makes the scripted tool calls, one script per round. It keeps every round's input, every tool result and every round's tool names. */
function scriptedAi(scripts: Call[][]) {
  const outputs: string[] = [];
  const inputs: string[] = [];
  const toolNames: string[][] = [];
  const runTools = jest.fn(async (req: { tools: Tools; onStep?: (s: unknown) => void; input: unknown }) => {
    inputs.push(typeof req.input === 'string' ? req.input : JSON.stringify(req.input));
    toolNames.push(req.tools.map((t) => t.tool.name));
    let step = 0;
    for (const [name, args] of scripts.shift() ?? []) {
      const t = req.tools.find((x) => x.tool.name === name);
      if (!t) {
        outputs.push(`NO TOOL ${name}`);
        continue;
      }
      outputs.push(String(await t.execute(args, { userId: 'u' })));
      req.onStep?.({ step: ++step, response: { usage: { inputTokens: 10, outputTokens: 5 } }, calls: [] });
    }
    return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
  });
  return { ai: { forUser: () => ({ runTools }) } as unknown as AiService, outputs, inputs, toolNames, runTools };
}

const lookup: Call = ['saved_identity', {}];
const finish = (result = 'Done.'): Call => ['finish', { success: true, result }];
const fill = (field: string, selector: string, part: 'day' | 'month' | 'year' | null = null, ref = 'details-1'): Call => ['fill_from_identity', { ref, field, selector, part }];

const notifier = { finished: jest.fn(), needsYou: jest.fn(), started: jest.fn(), savedLoginUsed: jest.fn(), savedApprovalsUsed: jest.fn() };

/** The run's secrets seam: registered, with or without identity support. */
function seamOf(opts: { state?: 'registered' | 'not_enabled'; identity?: boolean } = {}) {
  const prepare = jest.fn(async () => opts.state ?? 'registered');
  const outcome = jest.fn(async () => undefined);
  const identitySupported = jest.fn(async () => opts.identity ?? true);
  const providerAddress = jest.fn(async () => 'https://vault.example.test');
  return { seam: { prepare, outcome, identitySupported, providerAddress } as unknown as RunSecretsService, prepare, outcome, identitySupported };
}

function runnerOf(fabric: SecretsFabric, ai: AiService, seam?: RunSecretsService) {
  const questions = new QuestionsService(prisma, fabric.client, { enqueue: async () => undefined } as never, new QuestionEvents());
  const r = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, notifier as never, questions);
  if (seam) r.secrets = seam;
  return r;
}

/** An owner with a task that may use saved logins and saved identity details. */
async function owner(label: string, task: Record<string, unknown> = {}) {
  const { userId, token } = await login(`identity-${label}-${stamp}@example.test`);
  const db = prisma.forUser({ userId });
  const t = await db.task.create({ data: { userId, name: `Form ${label}`, goal: 'Fill the application', useSavedLogins: true, useSavedIdentity: true, confirmRiskyActions: false, ...task } });
  const newRun = (data: Record<string, unknown> = {}) => db.run.create({ data: { userId, taskId: t.id, goal: 'Fill the application', ...data } });
  return { userId, token, db, task: t, newRun };
}

/** Everything the console stored about a run, as one string: for the marker test. */
async function everythingAbout(runId: string): Promise<string> {
  const run = await prisma.run.findFirstOrThrow({ where: { id: runId } });
  const steps = JSON.stringify(await prisma.runStep.findMany({ where: { runId } }));
  const questions = JSON.stringify(await prisma.question.findMany({ where: { runId } }));
  return JSON.stringify(run) + steps + questions;
}

/** Every value the provider can hand over, and what the fake page shows after a select. */
const VALUES = [IDENTITY.fullName, IDENTITY.dob, IDENTITY.idNumber, IDENTITY.country, IDENTITY.city, 'Canary-Name'];
const expectNone = (text: string, values: readonly string[] = VALUES) => {
  for (const v of values) expect(text).not.toContain(v);
};

describe('saved identity: the switches', () => {
  it('offers the two tools only with the task switch, saved logins, a provider with identity support and (for an AI app) the app limit', async () => {
    const offered = async (task: Record<string, unknown>, seam = seamOf(), appLimits?: Record<string, unknown>) => {
      const o = await owner(`sw-${Math.random().toString(36).slice(2, 8)}`, task);
      const a = scriptedAi([[finish()]]);
      const run = await o.newRun(appLimits ? { appLimits: appLimits as never } : {});
      expect(await runnerOf(fakeSecretsFabric(ALLOWED_PAGE), a.ai, seam.seam).advance(run.id, o.userId, null)).toBe('succeeded');
      return { names: a.toolNames[0]!, inputs: a.inputs[0]!, seam };
    };
    const has = (n: string[]) => n.includes('saved_identity') && n.includes('fill_from_identity');

    const on = await offered({});
    expect(has(on.names)).toBe(true);
    expect(on.names).toContain('saved_logins');
    expect(on.seam.identitySupported).toHaveBeenCalled();

    // The task's own switch off: the logins work, identity does not, and the seam is not even asked.
    const off = await offered({ useSavedIdentity: false });
    expect(off.names).toContain('saved_logins');
    expect(off.names).not.toContain('saved_identity');
    expect(off.names).not.toContain('fill_from_identity');
    expect(off.seam.identitySupported).not.toHaveBeenCalled();

    // Saved logins off: nothing.
    const noLogins = await offered({ useSavedLogins: false });
    expect(noLogins.names).not.toContain('saved_logins');
    expect(noLogins.names).not.toContain('saved_identity');

    // The provider has no identity scope: no tools, and the run says why.
    const noScope = await offered({}, seamOf({ identity: false }));
    expect(noScope.names).toContain('saved_logins');
    expect(noScope.names).not.toContain('saved_identity');
    expect(noScope.inputs).toContain('Saved identity details are not available for this run');

    // The secrets slice is off: nothing.
    const notEnabled = await offered({}, seamOf({ state: 'not_enabled' }));
    expect(notEnabled.names).not.toContain('saved_identity');
  });

  it("an AI app's run never gets the identity tools without allowSavedIdentity", async () => {
    const limits = (over: Record<string, unknown>) => ({
      clientId: '00000000-0000-4000-8000-0000000000b1',
      clientName: 'Assistant',
      allowedDomains: [],
      confirmPurchases: false,
      policyId: null,
      allowedPolicyIds: [],
      appliedPolicyId: null,
      maxConcurrentRuns: 2,
      dailyRunLimit: 50,
      dailyCostLimitUsd: null,
      allowSavedLogins: true,
      ...over,
    });
    for (const [over, offered] of [
      [{}, false],
      [{ allowSavedIdentity: false }, false],
      [{ allowSavedIdentity: true }, true],
      // The identity limit never widens the logins limit.
      [{ allowSavedLogins: false, allowSavedIdentity: true }, false],
    ] as const) {
      const o = await owner(`app-${Math.random().toString(36).slice(2, 8)}`);
      const a = scriptedAi([[finish()]]);
      const run = await o.newRun({ appLimits: limits(over) as never });
      expect(await runnerOf(fakeSecretsFabric(ALLOWED_PAGE), a.ai, seamOf().seam).advance(run.id, o.userId, null)).toBe('succeeded');
      expect(a.toolNames[0]!.includes('saved_identity')).toBe(offered);
      expect(a.toolNames[0]!.includes('fill_from_identity')).toBe(offered);
    }
  });

  it("a chat run follows the chat's identity switch", async () => {
    const { userId } = await login(`identity-chat-${stamp}@example.test`);
    const db = prisma.forUser({ userId });
    for (const [logins, identity, offered] of [
      [true, false, false],
      [true, true, true],
      [false, true, false],
    ] as const) {
      const chat = await db.conversation.create({ data: { userId, title: 'Form', useSavedLogins: logins, useSavedIdentity: identity } });
      const run = await db.run.create({ data: { userId, conversationId: chat.id, trigger: 'chat', goal: 'Fill' } });
      const a = scriptedAi([[finish()]]);
      expect(await runnerOf(fakeSecretsFabric(ALLOWED_PAGE), a.ai, seamOf().seam).advance(run.id, userId, null)).toBe('succeeded');
      expect(a.toolNames[0]!.includes('saved_identity')).toBe(offered);
    }
  });
});

describe('saved identity: filling a form', () => {
  it('fills a name, a date of birth in three selects and an ID number; no value is in any step, result, question, memory or model input', async () => {
    const o = await owner('form');
    const fabric = fakeSecretsFabric(ALLOWED_PAGE);
    for (const part of ['day', 'month', 'year']) fabric.targets.set(`#dob-${part}`, { tag: 'select', label: part });
    const a = scriptedAi([
      [lookup, fill('full_name', '#name'), fill('date_of_birth', '#dob-day', 'day'), fill('date_of_birth', '#dob-month', 'month'), fill('date_of_birth', '#dob-year', 'year'), fill('id_number', '#idnum'), finish('Filled.')],
    ]);
    const run = await o.newRun();
    expect(await runnerOf(fabric, a.ai, seamOf().seam).advance(run.id, o.userId, null)).toBe('succeeded');

    // The model reads labels and flags, a per-run reference and no provider id.
    const listing = JSON.parse(a.outputs[0]!.split('\n')[0]!);
    expect(listing).toEqual([
      {
        ref: 'details-1',
        name: 'Passport',
        fields: [
          { key: 'full_name', label: 'Full name', sensitive: false, usableHere: true },
          { key: 'date_of_birth', label: 'Date of birth', sensitive: true, usableHere: true },
          { key: 'id_number', label: 'ID number', sensitive: true, usableHere: true },
          { key: 'country', label: 'Country', sensitive: false, usableHere: true },
          { key: 'city', label: 'City', sensitive: false, usableHere: true },
        ],
      },
    ]);
    expect(a.outputs[0]).not.toContain(IDENTITY.itemId);
    expect(a.outputs.slice(1, 6).every((x) => /^Filled /.test(x))).toBe(true);
    expect(await o.db.question.count({ where: { runId: run.id } })).toBe(0);

    // The fabric did the work: the form purpose, the field key, a select for each part of the date, nothing typed by the console.
    const provider = fabric.actions.filter((x) => x.type === 'type_from_provider' || x.type === 'select_from_provider');
    expect(provider).toEqual([
      expect.objectContaining({ type: 'type_from_provider', item_id: IDENTITY.itemId, field: 'full_name', selector: '#name', purpose: 'form', clear: true, submit: false, run_id: run.id }),
      expect.objectContaining({ type: 'select_from_provider', field: 'date_of_birth', selector: '#dob-day', part: 'day' }),
      expect.objectContaining({ type: 'select_from_provider', field: 'date_of_birth', selector: '#dob-month', part: 'month' }),
      expect.objectContaining({ type: 'select_from_provider', field: 'date_of_birth', selector: '#dob-year', part: 'year' }),
      expect.objectContaining({ type: 'type_from_provider', field: 'id_number', selector: '#idnum', purpose: 'form' }),
    ]);
    expect(fabric.actions.some((x) => x.type === 'type' || x.type === 'type_secret')).toBe(false);
    // Positive control: the page holds the values (that is where they live).
    expect(JSON.stringify(fabric.page.fields)).toContain(IDENTITY.idNumber);

    // Steps and the run's record: labels only. "Filled from your saved details: Full name, Date of birth, ID number".
    const steps = await prisma.runStep.findMany({ where: { runId: run.id }, orderBy: { seq: 'asc' } });
    expect(steps.map((s) => s.summary)).toEqual(
      expect.arrayContaining(['looked up saved details: 1 item, 5 fields', "filled Full name from the saved details 'Passport'", "filled Date of birth from the saved details 'Passport'", "filled ID number from the saved details 'Passport'"]),
    );
    const row = await prisma.run.findFirstOrThrow({ where: { id: run.id } });
    expect(row.usedSavedIdentity).toEqual([
      { provider: 'test', itemName: 'Passport', label: 'Full name', origin: FIXTURE.origin, at: expect.any(String) },
      { provider: 'test', itemName: 'Passport', label: 'Date of birth', origin: FIXTURE.origin, at: expect.any(String) },
      { provider: 'test', itemName: 'Passport', label: 'ID number', origin: FIXTURE.origin, at: expect.any(String) },
    ]);

    // The API says it too.
    const view = await app.inject({ method: 'GET', url: `/api/runs/${run.id}`, headers: { authorization: `Bearer ${o.token}` } });
    expect(view.json<{ data: { usedSavedIdentity: unknown[] } }>().data.usedSavedIdentity).toHaveLength(3);

    // Marker: no value in a step, the run (memory included), a question, a tool result or the model's input.
    expectNone(await everythingAbout(run.id));
    expectNone(a.outputs.join('\n'));
    expectNone(a.inputs.join('\n'));
    expectNone(JSON.stringify(view.json()));
    // The audit the fabric keeps names the field, never the value (the fake records what it was asked).
    expect(fabric.providerCalls.filter((c) => c.op === 'release').map((c) => [c.field, c.purpose, c.part ?? null])).toEqual([
      ['full_name', 'form', null],
      ['date_of_birth', 'form', 'day'],
      ['date_of_birth', 'form', 'month'],
      ['date_of_birth', 'form', 'year'],
      ['id_number', 'form', null],
    ]);
  });

  it('refuses a field that is not in the lookup, a reference that is not, and a page that changed since the lookup', async () => {
    const o = await owner('refusals');
    const fabric = fakeSecretsFabric(ALLOWED_PAGE);
    const a = scriptedAi([[fill('full_name', '#name'), lookup, fill('full_name', '#name', null, 'details-9'), fill('phone', '#phone'), ['fill_from_identity', { ref: 'details-1', field: 'full_name', selector: '#name', part: 'day' }], finish()]]);
    const run = await o.newRun();
    expect(await runnerOf(fabric, a.ai, seamOf().seam).advance(run.id, o.userId, null)).toBe('succeeded');
    expect(a.outputs[0]).toMatch(/Call saved_identity first/);
    expect(a.outputs[2]).toMatch(/There is no saved item "details-9"/);
    expect(a.outputs[3]).toMatch(/has no field "phone"\. Its fields: full_name, date_of_birth/);
    expect(a.outputs[4]).toMatch(/`part` is only for a select/);
    expect(fabric.actions.some((x) => x.type === 'type_from_provider' || x.type === 'select_from_provider')).toBe(false);

    // The page moved to another site after the lookup: nothing is filled.
    const fabric2 = fakeSecretsFabric(ALLOWED_PAGE);
    fabric2.state.afterLookup = () => {
      fabric2.page.url = OTHER_PAGE;
    };
    const moving = scriptedAi([[lookup, fill('full_name', '#name'), finish()]]);
    const run2 = await o.newRun();
    expect(await runnerOf(fabric2, moving.ai, seamOf().seam).advance(run2.id, o.userId, null)).toBe('succeeded');
    expect(moving.outputs[1]).toMatch(/The page changed since saved_identity looked it up/);
    expect(fabric2.actions.some((x) => x.type === 'type_from_provider')).toBe(false);
  });

  it('a missing detail is asked for once, with every missing field in one request', async () => {
    const o = await owner('missing');
    const fabric = fakeSecretsFabric(ALLOWED_PAGE);
    // The item has no phone number or address: the model asks once for both.
    const prompt = 'Which phone number and street address should I use on the form?';
    const a = scriptedAi([[lookup, ['request_human', { kind: 'other', prompt, input: 'text', choices: null, options: null, remember_label: null }]]]);
    const run = await o.newRun();
    expect(await runnerOf(fabric, a.ai, seamOf().seam).advance(run.id, o.userId, null)).toBe('waiting_human');
    expect(a.outputs[0]).toContain('ask the owner once for all missing details together');
    const questions = await o.db.question.findMany({ where: { runId: run.id } });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ input: 'text', prompt });
  });
});

describe('saved identity: a detail this site is not allowed to have', () => {
  it('tells the model, asks the owner with the two choices, and (Type it this time) asks for a secret the fabric types', async () => {
    const o = await owner('card');
    const fabric = fakeSecretsFabric(OTHER_PAGE);
    const a = scriptedAi([
      [lookup, fill('full_name', '#name'), fill('id_number', '#idnum')],
      // After the owner typed it (a handoff secret), the model types it into the field.
      [['type_handoff_secret', { selector: '#idnum', submit: false }], finish('Done.')],
    ]);
    const run = await o.newRun();
    const runner = runnerOf(fabric, a.ai, seamOf().seam);
    expect(await runner.advance(run.id, o.userId, null)).toBe('waiting_human');

    // The listing says which are usable here; the non-sensitive field was filled; the sensitive one was not.
    const listing = JSON.parse(a.outputs[0]!.split('\n')[0]!)[0].fields as { key: string; usableHere: boolean }[];
    expect(listing.find((f) => f.key === 'id_number')!.usableHere).toBe(false);
    expect(listing.find((f) => f.key === 'full_name')!.usableHere).toBe(true);
    expect(a.outputs[1]).toMatch(/^Filled Full name/);
    expect(a.outputs[2]).toContain('This detail is saved but not allowed on this site');
    expect(fabric.actions.filter((x) => x.type === 'type_from_provider').map((x) => x.field)).toEqual(['full_name']);

    // The card: the two choices, naming the field, the item and the site, and where to allow it.
    const q = await o.db.question.findFirstOrThrow({ where: { runId: run.id } });
    expect(q.input).toBe('choice');
    expect(q.prompt).toContain('ID number');
    expect(q.prompt).toContain("'Passport'");
    expect(q.prompt).toContain('other.example.test');
    expect(q.prompt).toContain('https://vault.example.test');
    expect((q.options as { id: string; label: string }[]).map((x) => [x.id, x.label])).toEqual([
      ['allow_site', 'Allow this site for ID number'],
      ['type_now', 'Type it this time'],
    ]);
    expectNone(JSON.stringify(q));

    // "Type it this time": a secret request follows at once, and no model round runs before it is answered.
    fabric.answer([...fabric.handoffs.values()][0]!, { value: 'type_now' });
    expect(await runner.advance(run.id, o.userId, null)).toBe('waiting_human');
    const asked = await o.db.question.findMany({ where: { runId: run.id }, orderBy: { createdAt: 'asc' } });
    expect(asked.map((x) => x.input)).toEqual(['choice', 'secret']);
    expect(asked[1]!.prompt).toContain('ID number');
    expect(a.runTools).toHaveBeenCalledTimes(1);

    // The owner enters it; the fabric keeps it and the model types it by handoff, never seeing it.
    const secretHandoff = [...fabric.handoffs.values()][1]!;
    fabric.answer(secretHandoff, { value_withheld: true });
    expect(await runner.advance(run.id, o.userId, null)).toBe('succeeded');
    expect(fabric.actions.find((x) => x.type === 'type_secret')).toMatchObject({ handoff_id: secretHandoff.id, selector: '#idnum' });
    expect(a.inputs[1]).toContain('type_handoff_secret');
    expectNone(await everythingAbout(run.id));
    expectNone(a.inputs.join('\n') + a.outputs.join('\n'));
  });

  it('"Allow this site" makes the next fill ask the provider, and a detail it still refuses is asked about at most twice', async () => {
    const o = await owner('allow');
    const fabric = fakeSecretsFabric(OTHER_PAGE);
    const a = scriptedAi([[lookup, fill('date_of_birth', '#dob')], [fill('date_of_birth', '#dob')], [fill('date_of_birth', '#dob'), finish('Gave up.')]]);
    const run = await o.newRun();
    const runner = runnerOf(fabric, a.ai, seamOf().seam);
    expect(await runner.advance(run.id, o.userId, null)).toBe('waiting_human');
    // The owner says they allowed it (they did not): the fill asks the provider, which still refuses, so the owner is asked once more.
    fabric.answer([...fabric.handoffs.values()][0]!, { value: 'allow_site' });
    expect(await runner.advance(run.id, o.userId, null)).toBe('waiting_human');
    expect(a.inputs[1]).toContain('The owner says they allowed this site for Date of birth');
    expect(fabric.providerCalls.filter((c) => c.op === 'release' && c.field === 'date_of_birth')).toHaveLength(1);
    fabric.answer([...fabric.handoffs.values()][1]!, { value: 'allow_site' });
    expect(await runner.advance(run.id, o.userId, null)).toBe('succeeded');
    expect(await o.db.question.count({ where: { runId: run.id } })).toBe(2);
    expect(a.outputs.at(-2)).toContain('the owner was already asked');
    expect(fabric.actions.some((x) => x.type === 'type_from_provider' && x.field === 'date_of_birth' && fabric.page.fields['#dob'] !== undefined)).toBe(false);
  });

  it('"Allow this site" that really was done: the next fill goes through', async () => {
    const o = await owner('allowed');
    const fabric = fakeSecretsFabric(OTHER_PAGE);
    const a = scriptedAi([[lookup, fill('id_number', '#idnum')], [fill('id_number', '#idnum'), finish('Filled.')]]);
    const run = await o.newRun();
    const runner = runnerOf(fabric, a.ai, seamOf().seam);
    expect(await runner.advance(run.id, o.userId, null)).toBe('waiting_human');
    // The owner added the site in the provider.
    fabric.state.identities[0]!.allowedOrigins.push('https://other.example.test');
    fabric.answer([...fabric.handoffs.values()][0]!, { value: 'allow_site' });
    expect(await runner.advance(run.id, o.userId, null)).toBe('succeeded');
    expect(a.outputs.at(-2)).toMatch(/^Filled ID number/);
    expect(fabric.page.fields['#idnum']).toBe(IDENTITY.idNumber);
    expect(await o.db.question.count({ where: { runId: run.id } })).toBe(1);
  });

  it('an http page never gets a sensitive field, and the model is told so (no card: typing it would not help)', async () => {
    const o = await owner('http');
    const fabric = fakeSecretsFabric('http://127.0.0.1:8080/form');
    // Allowed on that origin by the provider, refused by the fabric's rule.
    fabric.state.identities[0]!.allowedOrigins.push('http://127.0.0.1:8080');
    const a = scriptedAi([[lookup, fill('id_number', '#idnum'), fill('city', '#city'), finish()]]);
    const run = await o.newRun();
    expect(await runnerOf(fabric, a.ai, seamOf().seam).advance(run.id, o.userId, null)).toBe('succeeded');
    expect(a.outputs[1]).toContain('does not use https');
    expect(a.outputs[2]).toMatch(/^Filled City/);
    expect(await o.db.question.count({ where: { runId: run.id } })).toBe(0);
  });

  it('the provider failing is an instruction to ask for the details, never a value or a provider message', async () => {
    const o = await owner('fail');
    const fabric = fakeSecretsFabric(ALLOWED_PAGE);
    fabric.state.failAll = 'unavailable';
    const seam = seamOf();
    const a = scriptedAi([[lookup, finish()]]);
    const run = await o.newRun();
    expect(await runnerOf(fabric, a.ai, seam.seam).advance(run.id, o.userId, null)).toBe('succeeded');
    expect(a.outputs[0]).toContain('Saved details are not available right now');
    expect(a.outputs[0]).toContain('request_human');
    expect(seam.outcome).toHaveBeenCalledWith(o.userId, { ok: false, code: 'UNAVAILABLE' });
  });
});

describe('saved identity: what the fabric filled is never read back', () => {
  it('observe_elements, read_text and run_javascript return the marker for a filled input (a saved login password too), and the pictures cover it', async () => {
    const o = await owner('readback');
    const fabric = fakeSecretsFabric(ALLOWED_PAGE);
    fabric.state.screenshots = true;
    fabric.page.inputs = [
      { selector: '#name', tag: 'input' },
      { selector: '#pw', tag: 'input' },
      { selector: '#other', tag: 'input' },
    ];
    fabric.page.fields['#other'] = 'typed by the model: fine to read';
    const a = scriptedAi([
      // One chunk fills a detail and signs in with a saved login (its password is typed from the provider too) ...
      [lookup, fill('full_name', '#name'), ['saved_logins', {}], ['sign_in_with_saved_login', { ref: 'login-1', username_selector: null, password_selector: '#pw', submit: false }]],
      // ... the next reads everything back.
      [
        ['observe_elements', {}],
        ['read_text', { selector: '#name' }],
        ['read_text', { selector: '#pw' }],
        ['read_text', { selector: '#other' }],
        ['run_javascript', { script: "document.querySelector('#name').value", reason: 'check' }],
        ['run_javascript', { script: 'document.title', reason: 'title' }],
        ['read_text', { selector: null }],
        finish(),
      ],
    ]);
    const run = await o.newRun();
    expect(await runnerOf(fabric, a.ai, seamOf().seam).advance(run.id, o.userId, null)).toBe('succeeded');
    // Positive control: the page holds both values.
    expect(fabric.page.fields['#name']).toBe(IDENTITY.fullName);
    expect(fabric.page.fields['#pw']).toBe(FIXTURE.password);

    const read = a.outputs.slice(4);
    const [elements, nameText, pwText, otherText, jsValue, jsTitle, pageText] = read;
    // The listing: the filled inputs read as the marker, the model's own input as it is.
    expect(JSON.parse(elements!)).toEqual([
      expect.objectContaining({ selector: '#name', text: MARKER }),
      expect.objectContaining({ selector: '#pw', text: MARKER }),
      expect.objectContaining({ selector: '#other', text: 'typed by the model: fine to read' }),
    ]);
    expect(nameText).toBe(MARKER);
    expect(pwText).toBe(MARKER);
    expect(otherText).toBe('typed by the model: fine to read');
    // A script that reads a value gets the marker; one that does not is untouched.
    expect(jsValue).toContain(MARKER);
    expect(jsTitle).not.toContain(MARKER);
    expect(pageText).toBe('Apply for a card');

    // No value anywhere the model reads.
    expectNone(a.outputs.join('\n') + a.inputs.join('\n'), [IDENTITY.fullName, FIXTURE.password, 'Canary-Name']);
    // The picture of the next round was taken with both inputs covered, and the marks said so.
    expect(fabric.covers.length).toBeGreaterThan(0);
    expect(fabric.covers.at(-1)).toEqual(['#name', '#pw']);
    const shot = fabric.shots.at(-1);
    expect(shot).toMatchObject({ screen: 'page', covered: true });
    expect(a.inputs[1]).toContain(MARKER);
    expect(fabric.page.covered).toBe(false);
  });

  it('a desktop picture is not taken while a filled input is on the page', async () => {
    const o = await owner('desktop');
    const fabric = fakeSecretsFabric(ALLOWED_PAGE);
    fabric.state.screenshots = true;
    const a = scriptedAi([[lookup, fill('city', '#city'), ['look', { screen: 'desktop', reason: 'a dialog' }]], [finish()]]);
    const run = await o.newRun();
    expect(await runnerOf(fabric, a.ai, seamOf().seam).advance(run.id, o.userId, null)).toBe('succeeded');
    expect(fabric.shots.some((s) => s.screen === 'desktop')).toBe(false);
    expect(a.inputs[1]).toContain('No desktop screenshot this round');
  });
});

describe('saved identity: a task parameter taken from a saved field', () => {
  it('shows [provided: …] in the goal, fills the field with the fabric and stores no value', async () => {
    const { userId, token } = await login(`identity-param-${stamp}@example.test`);
    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'Apply',
        goal: 'Apply for the card with ID number {{ID number}} and city {{City}}',
        useSavedLogins: true,
        useSavedIdentity: true,
        parameters: [{ key: 'id_number', label: 'ID number', default: { identity: { field: 'id_number' } } }, { key: 'city', default: { value: 'Springfield' } }],
      },
    });
    expect(created.statusCode).toBe(201);
    const task = created.json<{ data: { id: string; useSavedIdentity: boolean; parameters: { key: string; default?: unknown }[] } }>().data;
    expect(task.useSavedIdentity).toBe(true);
    expect(task.parameters[0]!.default).toEqual({ identity: { field: 'id_number' } });

    const noJobs = { enqueue: async () => undefined } as never;
    const starter = new TaskRunStarter(prisma, noJobs, new QuestionEvents(), app.get(TasksService), app.get(TaskSchedulesService));
    const row = await prisma.forUser({ userId }).task.findFirstOrThrow({ where: { id: task.id } });
    const { run } = await starter.start({ id: userId }, row, { inputs: {}, reason: 'run_started', data: { trigger: 'manual' } });
    // Not asked for: the run starts at once, and the goal the model reads names the parameter, not its value.
    expect(run.status).toBe('queued');
    expect(run.goal).toBe('Apply for the card with ID number [provided: ID number] and city ⟦Springfield⟧');
    const stored = await prisma.run.findFirstOrThrow({ where: { id: run.id } });
    expect(stored.inputs).toMatchObject({ identity: [{ key: 'id_number', label: 'ID number', field: 'id_number' }] });
    expect(JSON.stringify(stored.inputs)).not.toContain(IDENTITY.idNumber);
    const view = await app.inject({ method: 'GET', url: `/api/runs/${run.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(view.json<{ data: { inputs: { key: string; value: string; source: string }[] } }>().data.inputs).toContainEqual(expect.objectContaining({ key: 'id_number', value: '[from your saved details]', source: 'saved_details' }));

    const fabric = fakeSecretsFabric(ALLOWED_PAGE);
    const a = scriptedAi([[lookup, fill('id_number', '#idnum'), finish('Applied.')]]);
    expect(await runnerOf(fabric, a.ai, seamOf().seam).advance(run.id, userId, null)).toBe('succeeded');
    // The model was told what the placeholder is, the fabric typed the field, and no value is anywhere.
    expect(a.inputs[0]).toContain('[provided: ID number] is your saved detail "id_number"');
    expect(fabric.actions.find((x) => x.type === 'type_from_provider')).toMatchObject({ field: 'id_number', selector: '#idnum', purpose: 'form' });
    expectNone(await everythingAbout(run.id));
    expectNone(a.inputs.join('\n') + a.outputs.join('\n'));
    expect(JSON.stringify((await app.inject({ method: 'GET', url: `/api/runs/${run.id}/export`, headers: { authorization: `Bearer ${token}` } })).body)).not.toContain(IDENTITY.idNumber);
  });

  it('without saved details available the parameter is asked for like a sensitive value', async () => {
    const { userId, token } = await login(`identity-param-off-${stamp}@example.test`);
    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Apply off', goal: 'Apply with ID number {{ID number}}', parameters: [{ key: 'id_number', label: 'ID number', default: { identity: { field: 'id_number' } } }] },
    });
    const task = created.json<{ data: { id: string; useSavedIdentity: boolean } }>().data;
    expect(task.useSavedIdentity).toBe(false);
    const noJobs = { enqueue: async () => undefined } as never;
    const starter = new TaskRunStarter(prisma, noJobs, new QuestionEvents(), app.get(TasksService), app.get(TaskSchedulesService));
    const row = await prisma.forUser({ userId }).task.findFirstOrThrow({ where: { id: task.id } });
    const { run } = await starter.start({ id: userId }, row, { inputs: {}, reason: 'run_started', data: { trigger: 'manual' } });
    const fabric = fakeSecretsFabric(ALLOWED_PAGE);
    const a = scriptedAi([[finish()]]);
    expect(await runnerOf(fabric, a.ai, seamOf().seam).advance(run.id, userId, null)).toBe('waiting_human');
    const asked = await prisma.forUser({ userId }).question.findFirstOrThrow({ where: { runId: run.id } });
    expect(asked).toMatchObject({ input: 'secret' });
    expect(asked.prompt).toContain('ID number');
    expect(a.runTools).not.toHaveBeenCalled();
  });

  it('refuses a default that names a field that is not an identity field', async () => {
    const { token } = await login(`identity-param-bad-${stamp}@example.test`);
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Bad', goal: 'Use {{Thing}}', parameters: [{ key: 'thing', default: { identity: { field: 'password' } } }] },
    });
    expect(res.statusCode).toBe(400);
  });
});
