// Unattended sign-in from a saved login (E37.3, #592) against a real database: a scripted model, the in-memory fabric
// of test/support/fake-secrets-fabric.ts (the `test` provider of E37.1) and the real question broker.
//
// What this proves: with the opt-in and one exact match the run signs in without a question; every other case asks the
// owner; the model never holds a value; a mismatch asks with a warning; an unattended run that signed in keeps asking
// before a payment; a password is typed once; a crash between two fields does not type again.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { QuestionEvents } from '../src/questions/question-events';
import { QuestionsService } from '../src/questions/questions.service';
import { GoalRunnerService } from '../src/runner/goal-runner.service';
import { RunSecretsService } from '../src/secrets/run-secrets.service';
import { TasksService } from '../src/tasks/tasks.service';
import { FIXTURE, fakeSecretsFabric, type SecretsFabric } from './support/fake-secrets-fabric';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;
const LOGIN_PAGE = `${FIXTURE.origin}/signin`;

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
    const script = scripts.shift() ?? [];
    let step = 0;
    for (const [name, args] of script) {
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

const signIn = (over: Record<string, unknown> = {}): Call => ['sign_in_with_saved_login', { ref: 'login-1', username_selector: '#user', password_selector: '#pw', submit: true, ...over }];
const lookup: Call = ['saved_logins', {}];
const finish = (result = 'Done.'): Call => ['finish', { success: true, result }];
const credentials = (prompt = 'Sign in to Example'): Call => ['request_human', { kind: 'login', prompt, input: 'credentials', choices: null, options: null, remember_label: null }];

const notifier = { finished: jest.fn(), needsYou: jest.fn(), started: jest.fn(), savedLoginUsed: jest.fn(), savedApprovalsUsed: jest.fn() };

/** The run's secrets seam: registered, or the reason it is not. Outcomes are recorded here. */
function secretsSeam(state: 'registered' | 'not_enabled' | 'not_connected' | 'needs_reconnect' | 'unavailable' = 'registered') {
  const prepare = jest.fn(async () => state);
  const outcome = jest.fn(async () => undefined);
  // Offering to save a typed sign-in (E37.4b) is off here: its own spec (save-login.db.spec.ts) covers it.
  const saveLoginSupported = jest.fn(async () => false);
  return { seam: { prepare, outcome, saveLoginSupported } as unknown as RunSecretsService, prepare, outcome };
}

function runnerOf(fabric: SecretsFabric, ai: AiService, seam?: RunSecretsService) {
  const questions = new QuestionsService(prisma, fabric.client, { enqueue: async () => undefined } as never, new QuestionEvents());
  const r = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, notifier as never, questions);
  if (seam) r.secrets = seam;
  return r;
}

/** An owner with a task that may use saved logins. */
async function owner(label: string, task: { useSavedLogins?: boolean; confirmRiskyActions?: boolean; unattendedPayments?: string } = {}) {
  const { userId, token } = await login(`saved-${label}-${stamp}@example.test`);
  const db = prisma.forUser({ userId });
  const t = await db.task.create({ data: { userId, name: `Sign in ${label}`, goal: 'Check the account', useSavedLogins: true, confirmRiskyActions: false, ...task } });
  const newRun = (data: Record<string, unknown> = {}) => db.run.create({ data: { userId, taskId: t.id, goal: 'Check the account', ...data } });
  return { userId, token, db, task: t, newRun };
}

/** Everything the console stored or showed about a run, as one string: for the marker test. */
async function everythingAbout(runId: string): Promise<{ stored: string; steps: string }> {
  const run = await prisma.run.findFirstOrThrow({ where: { id: runId } });
  const steps = JSON.stringify(await prisma.runStep.findMany({ where: { runId } }));
  const questions = JSON.stringify(await prisma.question.findMany({ where: { runId } }));
  return { stored: JSON.stringify(run) + steps + questions, steps: steps + JSON.stringify({ ...run, transcript: undefined }) + JSON.stringify(run.transcript) };
}

const PASSWORDS = [FIXTURE.password, FIXTURE.sitePassword, FIXTURE.code];

describe('saved logins: the opt-in', () => {
  it('offers no saved-login tool without the task switch, with it off in the seam, or from an app that is not allowed; and offers all three with them', async () => {
    const off = await owner('optin-off', { useSavedLogins: false });
    const seamOff = secretsSeam();
    const fabric = fakeSecretsFabric(LOGIN_PAGE);
    const a = scriptedAi([[finish()]]);
    expect(await runnerOf(fabric, a.ai, seamOff.seam).advance((await off.newRun()).id, off.userId, null)).toBe('succeeded');
    expect(a.toolNames[0]).not.toContain('saved_logins');
    expect(a.toolNames[0]).not.toContain('sign_in_with_saved_login');
    expect(a.toolNames[0]).not.toContain('type_saved_code');
    // The switch is off: the seam is not even asked, and the session carries no owner.
    expect(seamOff.prepare).not.toHaveBeenCalled();
    expect(fabric.sessions[0]).not.toHaveProperty('owner_id');

    const on = await owner('optin-on');
    const seam = secretsSeam();
    const fabric2 = fakeSecretsFabric(LOGIN_PAGE);
    const b = scriptedAi([[finish()]]);
    expect(await runnerOf(fabric2, b.ai, seam.seam).advance((await on.newRun()).id, on.userId, null)).toBe('succeeded');
    expect(b.toolNames[0]).toEqual(expect.arrayContaining(['saved_logins', 'sign_in_with_saved_login', 'type_saved_code']));
    expect(seam.prepare).toHaveBeenCalledWith(on.userId);
    expect(fabric2.sessions[0]).toMatchObject({ owner_id: on.userId });

    // A provider that is not connected, or a switch of the secrets slice that is off: no tools, and the run says so.
    for (const reason of ['not_enabled', 'not_connected', 'needs_reconnect', 'unavailable'] as const) {
      const o = await owner(`optin-${reason}`);
      const c = scriptedAi([[finish()]]);
      expect(await runnerOf(fakeSecretsFabric(LOGIN_PAGE), c.ai, secretsSeam(reason).seam).advance((await o.newRun()).id, o.userId, null)).toBe('succeeded');
      expect(c.toolNames[0]).not.toContain('saved_logins');
      expect(c.inputs[0]).toContain('Saved logins are not available for this run');
    }
  });

  it('an AI app run gets the tools only if the app\'s limits allow saved logins (default: no)', async () => {
    const o = await owner('optin-app');
    const limits = (allowSavedLogins?: boolean) => ({
      clientId: '00000000-0000-4000-8000-0000000000a1',
      clientName: 'Assistant',
      allowedDomains: [],
      confirmPurchases: false,
      policyId: null,
      allowedPolicyIds: [],
      appliedPolicyId: null,
      maxConcurrentRuns: 2,
      dailyRunLimit: 50,
      dailyCostLimitUsd: null,
      ...(allowSavedLogins === undefined ? {} : { allowSavedLogins }),
    });
    for (const [allow, offered] of [
      [undefined, false],
      [false, false],
      [true, true],
    ] as const) {
      const seam = secretsSeam();
      const a = scriptedAi([[finish()]]);
      const run = await o.newRun({ appLimits: limits(allow) as never });
      expect(await runnerOf(fakeSecretsFabric(LOGIN_PAGE), a.ai, seam.seam).advance(run.id, o.userId, null)).toBe('succeeded');
      expect(a.toolNames[0]!.includes('saved_logins')).toBe(offered);
      expect(seam.prepare).toHaveBeenCalledTimes(offered ? 1 : 0);
    }
  });

  it('a chat run follows the chat\'s switch', async () => {
    const { userId } = await login(`saved-chat-optin-${stamp}@example.test`);
    const db = prisma.forUser({ userId });
    for (const on of [false, true]) {
      const chat = await db.conversation.create({ data: { userId, title: 'Sign in', useSavedLogins: on } });
      const run = await db.run.create({ data: { userId, conversationId: chat.id, trigger: 'chat', goal: 'Sign in' } });
      const a = scriptedAi([[finish()]]);
      expect(await runnerOf(fakeSecretsFabric(LOGIN_PAGE), a.ai, secretsSeam().seam).advance(run.id, userId, null)).toBe('succeeded');
      expect(a.toolNames[0]!.includes('saved_logins')).toBe(on);
    }
  });
});

describe('saved logins: one exact match signs in without a question', () => {
  it('types the username and the password from the provider, records it, and no value is anywhere', async () => {
    const o = await owner('exact');
    const fabric = fakeSecretsFabric(LOGIN_PAGE);
    const seam = secretsSeam();
    const a = scriptedAi([[lookup, signIn(), finish('Signed in.')]]);
    const run = await o.newRun();
    expect(await runnerOf(fabric, a.ai, seam.seam).advance(run.id, o.userId, null)).toBe('succeeded');

    // No question, and the model got a reference, never the provider's id.
    expect(await o.db.question.count({ where: { runId: run.id } })).toBe(0);
    expect(a.outputs[0]).toContain('"ref":"login-1"');
    expect(a.outputs[0]).toContain('"exact":true');
    expect(a.outputs[0]).toContain('"hasCode":true');
    expect(a.outputs[0]).toContain('Exactly one login is saved for this address');
    expect(a.outputs[0]).not.toContain(FIXTURE.itemId);
    expect(a.outputs[1]).toMatch(/Typed username and password of the saved login login-1/);

    // The fabric typed from the provider, username then password, the second with Enter; the owner was the provider's owner.
    expect(fabric.actions.filter((x) => x.type === 'type_from_provider')).toEqual([
      expect.objectContaining({ type: 'type_from_provider', item_id: FIXTURE.itemId, field: 'username', selector: '#user', purpose: 'login', clear: true, submit: false, run_id: run.id }),
      expect.objectContaining({ type: 'type_from_provider', item_id: FIXTURE.itemId, field: 'password', selector: '#pw', purpose: 'login', clear: true, submit: true, run_id: run.id }),
    ]);
    expect(fabric.actions.some((x) => x.type === 'type' || x.type === 'type_secret')).toBe(false);
    expect(fabric.providerCalls.map((c) => c.origin)).toEqual([FIXTURE.origin, FIXTURE.origin, FIXTURE.origin]);
    expect(fabric.providerCalls.every((c) => c.clientLabel === 'Hexactra')).toBe(true);
    expect(seam.outcome).toHaveBeenCalledWith(o.userId, { ok: true });

    // Steps: the lookup, the phases, the sign-in with the item's name and the masked username.
    const steps = await prisma.runStep.findMany({ where: { runId: run.id }, orderBy: { seq: 'asc' } });
    expect(steps.map((s) => s.summary)).toEqual(
      expect.arrayContaining([
        // The fixture's second login is saved for another address of the same site: it is listed, never usable.
        'looked up saved logins: 2 matches, 1 exact',
        "signed in with the saved login 'Example login' (username p•••@example.test)",
        "typing the username of the saved login 'Example login' (username p•••@example.test)",
        "typing the password of the saved login 'Example login' (username p•••@example.test)",
      ]),
    );
    expect(steps.find((s) => s.action === 'sign_in_with_saved_login')).toMatchObject({ kind: 'action', ok: true });

    // The run records which login, where, and when.
    const row = await prisma.run.findFirstOrThrow({ where: { id: run.id } });
    expect(row.usedSavedLogins).toEqual([{ provider: 'test', itemName: 'Example login', origin: FIXTURE.origin, at: expect.any(String) }]);

    // Marker: no password, no code and no raw username in a step or the run; no password or code in the model's input, a tool result or a question.
    const seen = await everythingAbout(run.id);
    for (const v of PASSWORDS) {
      expect(seen.stored).not.toContain(v);
      expect(a.inputs.join('\n')).not.toContain(v);
      expect(a.outputs.join('\n')).not.toContain(v);
    }
    expect(seen.steps).not.toContain(FIXTURE.username);
    expect(a.inputs.join('\n')).not.toContain(FIXTURE.itemId);
  });

  it('GET /api/runs/:id returns usedSavedLogins, and an unused run returns an empty list', async () => {
    const o = await owner('exact-api');
    const a = scriptedAi([[lookup, signIn(), finish()]]);
    const run = await o.newRun();
    await runnerOf(fakeSecretsFabric(LOGIN_PAGE), a.ai, secretsSeam().seam).advance(run.id, o.userId, null);
    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}`, headers: { authorization: `Bearer ${o.token}` } });
    expect(res.json<{ data: { usedSavedLogins: unknown[] } }>().data.usedSavedLogins).toEqual([expect.objectContaining({ provider: 'test', itemName: 'Example login', origin: FIXTURE.origin })]);
    const plain = await o.newRun();
    const res2 = await app.inject({ method: 'GET', url: `/api/runs/${plain.id}`, headers: { authorization: `Bearer ${o.token}` } });
    expect(res2.json<{ data: { usedSavedLogins: unknown[] } }>().data.usedSavedLogins).toEqual([]);
  });

  it('a site that splits the sign-in over two pages: one selector per call', async () => {
    const o = await owner('split');
    const fabric = fakeSecretsFabric(LOGIN_PAGE);
    const a = scriptedAi([[lookup, signIn({ password_selector: null, submit: true })], [lookup, signIn({ username_selector: null, password_selector: '#pw' }), finish()]]);
    const run = await o.newRun();
    const runner = runnerOf(fabric, a.ai, secretsSeam().seam);
    expect(await runner.advance(run.id, o.userId, null)).toBe('succeeded');
    expect(a.outputs[1]).toContain('Typed the username of the saved login login-1');
    expect(fabric.actions.filter((x) => x.type === 'type_from_provider').map((x) => x.field)).toEqual(['username', 'password']);
  });
});

describe('saved logins: when it must ask the owner', () => {
  it('no match: the tool says to ask, the run asks with the credentials card and continues after the answer', async () => {
    const o = await owner('none');
    const fabric = fakeSecretsFabric('https://nowhere.example.org/login');
    const a = scriptedAi([[lookup, credentials('Sign in to Nowhere')], [finish('Done.')]]);
    const run = await o.newRun();
    const runner = runnerOf(fabric, a.ai, secretsSeam().seam);
    expect(await runner.advance(run.id, o.userId, null)).toBe('waiting_human');
    expect(a.outputs[0]).toMatch(/^none: no saved login for this page/);
    expect(a.outputs[0]).toContain('request_human');
    expect([...fabric.handoffs.values()][0]).toMatchObject({ input: 'credentials', kind: 'login' });
    expect(fabric.typed()).toEqual([]);
    fabric.answer([...fabric.handoffs.values()][0]!, { value: 'oscar', value_withheld: true });
    expect(await runner.advance(run.id, o.userId, null)).toBe('succeeded');
    expect((await prisma.run.findFirstOrThrow({ where: { id: run.id } })).usedSavedLogins).toBeNull();
  });

  it('a site-only match: no login is usable, and the sign-in is refused with "a different address"', async () => {
    const o = await owner('site');
    const fabric = fakeSecretsFabric('https://shop.example.test/login');
    const a = scriptedAi([[lookup, signIn({ ref: 'login-1' }), credentials()]]);
    const run = await o.newRun();
    expect(await runnerOf(fabric, a.ai, secretsSeam().seam).advance(run.id, o.userId, null)).toBe('waiting_human');
    expect(a.outputs[0]).toContain('"exact":false');
    expect(a.outputs[0]).toContain('None of these is saved for this exact address');
    expect(a.outputs[1]).toBe('That login is saved for a different address of this site. Ask the owner: call request_human with kind "login", input "credentials".');
    expect(fabric.typed()).toEqual([]);
    expect([...fabric.handoffs.values()][0]).toMatchObject({ input: 'credentials' });
    expect((await prisma.run.findFirstOrThrow({ where: { id: run.id } })).usedSavedLogins).toBeNull();
  });

  it('several exact matches: the owner chooses (names and usernames as choices), and only that login is used', async () => {
    const o = await owner('several');
    const fabric = fakeSecretsFabric(LOGIN_PAGE);
    fabric.state.items.push({ id: 'test-login-3', name: 'Work login', username: 'person-c@example.test', password: 'canary-pw-3-test', code: null, origins: [FIXTURE.origin] });
    const options = [
      { id: 'login-1', label: 'Example login (person-a@example.test)', description: null },
      { id: 'login-2', label: 'Work login (person-c@example.test)', description: null },
    ];
    const a = scriptedAi([
      [lookup, signIn(), ['request_human', { kind: 'login', prompt: 'Which login for Example?', input: 'choice', choices: null, options, remember_label: null }]],
      [signIn({ ref: 'login-2' }), finish()],
    ]);
    const run = await o.newRun();
    const runner = runnerOf(fabric, a.ai, secretsSeam().seam);
    expect(await runner.advance(run.id, o.userId, null)).toBe('waiting_human');
    // The tool names both candidates, with their usernames, as the options the model must ask with; signing in before the owner chose is refused.
    expect(a.outputs[0]).toContain('Several logins are saved for this address');
    expect(a.outputs[0]).toContain('Example login (person-a@example.test)');
    expect(a.outputs[0]).toContain('Work login (person-c@example.test)');
    expect(a.outputs[1]).toMatch(/Several logins are saved for this address, and the owner has not chosen one/);
    expect(fabric.typed()).toEqual([]);
    const q = await o.db.question.findFirstOrThrow({ where: { runId: run.id } });
    expect(q.input).toBe('choice');
    expect((q.options as { id: string; label: string }[]).map((x) => x.label)).toEqual(['Example login (person-a@example.test)', 'Work login (person-c@example.test)']);

    fabric.answer([...fabric.handoffs.values()][0]!, { value: 'login-2' });
    expect(await runner.advance(run.id, o.userId, null)).toBe('succeeded');
    expect(a.inputs[1]).toContain('The owner chose the saved login login-2');
    // The reference the owner chose, and no other.
    expect(fabric.typed().map((c) => c.itemId)).toEqual(['test-login-3', 'test-login-3']);
    expect((await prisma.run.findFirstOrThrow({ where: { id: run.id } })).usedSavedLogins).toEqual([expect.objectContaining({ itemName: 'Work login' })]);
  });

  it.each([
    ['unavailable', 'UNAVAILABLE'],
    ['disabled', 'DISABLED'],
    ['unauthorized', 'UNAUTHORIZED'],
    ['rate_limited', 'RATE_LIMITED'],
  ] as const)('the provider is %s: the run falls back to the credentials card and continues after the answer', async (mode, code) => {
    const o = await owner(`fallback-${mode}`);
    const fabric = fakeSecretsFabric(LOGIN_PAGE);
    fabric.state.failAll = mode;
    const seam = secretsSeam();
    const a = scriptedAi([[lookup, credentials()], [finish()]]);
    const run = await o.newRun();
    const runner = runnerOf(fabric, a.ai, seam.seam);
    expect(await runner.advance(run.id, o.userId, null)).toBe('waiting_human');
    expect(a.outputs[0]).toBe('Saved logins are not available right now. Ask the owner to sign in: call request_human with kind "login", input "credentials".');
    expect(seam.outcome).toHaveBeenCalledWith(o.userId, { ok: false, code });
    expect([...fabric.handoffs.values()][0]).toMatchObject({ input: 'credentials' });
    fabric.answer([...fabric.handoffs.values()][0]!, { value: 'oscar', value_withheld: true });
    expect(await runner.advance(run.id, o.userId, null)).toBe('succeeded');
  });

  it('a failure while typing (the vault went away after the lookup) reads the same and types nothing more', async () => {
    const o = await owner('fallback-typing');
    const fabric = fakeSecretsFabric(LOGIN_PAGE);
    fabric.state.failTyping = ['unavailable'];
    const a = scriptedAi([[lookup, signIn(), credentials()]]);
    const run = await o.newRun();
    expect(await runnerOf(fabric, a.ai, secretsSeam().seam).advance(run.id, o.userId, null)).toBe('waiting_human');
    expect(a.outputs[1]).toContain('Saved logins are not available right now');
    expect(fabric.typed()).toHaveLength(1);
    expect((await prisma.run.findFirstOrThrow({ where: { id: run.id } })).usedSavedLogins).toBeNull();
  });
});

describe('saved logins: the page is not the site (OriginMismatch)', () => {
  it('ends the attempt, asks the owner with a warning, and tells the model not to try another login', async () => {
    const o = await owner('mismatch');
    const fabric = fakeSecretsFabric(LOGIN_PAGE);
    // The provider refuses the password: the fabric read an origin the login is not saved for.
    fabric.state.failTyping = [];
    const seam = secretsSeam();
    const a = scriptedAi([[lookup, signIn()], [lookup, signIn({ ref: 'login-2' }), finish()]]);
    const run = await o.newRun();
    // The first field is fine; the fabric then reports the mismatch for the second.
    const typing = fabric.request.getMockImplementation()!;
    let calls = 0;
    fabric.request.mockImplementation(async (method: string, path: string, opts: { body?: Record<string, unknown> } = {}) => {
      if (opts.body?.action && (opts.body.action as Record<string, unknown>).type === 'type_from_provider' && ++calls === 2) return { id: 'op', state: 'failed', error: 'origin_mismatch: the page is not the site this login is saved for' };
      return typing(method, path, opts);
    });
    const runner = runnerOf(fabric, a.ai, seam.seam);
    expect(await runner.advance(run.id, o.userId, null)).toBe('waiting_human');
    expect(a.outputs[1]).toContain('Stop. This page is not the site this login is saved for. Do not try another login. Tell the owner.');
    const q = await o.db.question.findFirstOrThrow({ where: { runId: run.id } });
    expect(q).toMatchObject({ kind: 'login', input: 'takeover' });
    expect(q.prompt).toMatch(/^Warning: .*not the site that login is saved for/);
    // Both addresses, so the owner can tell a look-alike from the real site (E37.4).
    expect(q.prompt).toContain('The page is login.example.test.');
    expect(q.prompt).toContain('The login is saved for login.example.test.');
    expect(seam.outcome).toHaveBeenCalledWith(o.userId, { ok: false, code: 'ORIGIN_MISMATCH' });

    // The owner looks, and the next round's input carries the instruction; saved logins are off for the rest of the run.
    fabric.answer([...fabric.handoffs.values()][0]!, {});
    expect(await runner.advance(run.id, o.userId, null)).toBe('succeeded');
    expect(a.inputs[1]).toContain('Do not try another login');
    expect(a.outputs[2]).toContain('Saved logins are switched off for the rest of this run');
    expect(a.outputs[3]).toContain('Saved logins are switched off for the rest of this run');
    // Nothing was typed after the mismatch: the username went in, the password was refused.
    expect(fabric.typed()).toHaveLength(1);
  });

  it('a page that moved to a look-alike address since the lookup types nothing at all', async () => {
    const o = await owner('lookalike');
    const fabric = fakeSecretsFabric(LOGIN_PAGE);
    const a = scriptedAi([[lookup, ['navigate', { url: 'https://login.example.test.evil.example.net/signin', reason: 'follow the link' }], signIn(), credentials()]]);
    const run = await o.newRun();
    fabric.page.url = 'https://login.example.test.evil.example.net/signin';
    // The lookup is made on the real page; the browser is then on the look-alike.
    const real = fabric.request.getMockImplementation()!;
    let moved = false;
    fabric.request.mockImplementation(async (method: string, path: string, opts: { body?: Record<string, unknown> } = {}) => {
      const type = (opts.body?.action as Record<string, unknown> | undefined)?.type;
      if (type === 'secrets_lookup') {
        moved = true;
        const saved = fabric.page.url;
        fabric.page.url = LOGIN_PAGE;
        try {
          return await real(method, path, opts);
        } finally {
          fabric.page.url = saved;
        }
      }
      return real(method, path, opts);
    });
    expect(await runnerOf(fabric, a.ai, secretsSeam().seam).advance(run.id, o.userId, null)).toBe('waiting_human');
    expect(moved).toBe(true);
    expect(a.outputs[2]).toContain('The page changed since saved_logins looked it up');
    expect(fabric.typed()).toEqual([]);
  });
});

describe('saved logins: the password goes only into a password field (E37.10)', () => {
  it('a plain text box is refused by the fabric: nothing typed, the run asks the owner, and a real password field still works afterwards', async () => {
    const o = await owner('not-password');
    const fabric = fakeSecretsFabric(LOGIN_PAGE);
    // The model names a visible text box (a comment field, say) for the password: the fabric refuses before the provider is asked.
    fabric.state.notPassword = ['#comment'];
    const seam = secretsSeam();
    const a = scriptedAi([[lookup, signIn({ username_selector: null, password_selector: '#comment' })], [signIn({ username_selector: null, password_selector: '#pw' }), finish()]]);
    const run = await o.newRun();
    const runner = runnerOf(fabric, a.ai, seam.seam);
    expect(await runner.advance(run.id, o.userId, null)).toBe('waiting_human');

    // Nothing was fetched or typed, and the model is told not to type the password itself.
    expect(fabric.typed()).toEqual([]);
    expect(fabric.page.fields['#comment']).toBeUndefined();
    expect(fabric.providerCalls.filter((c) => c.op === 'release')).toEqual([]);
    expect(a.outputs[1]).toContain('not a password field');
    expect(a.outputs[1]).toContain('Do not type the password yourself');
    expect(a.outputs[1]).toContain('The owner has been asked to sign in.');

    // The run asks the owner to sign in (a takeover card, not a warning about a wrong site); saved logins stay on.
    const q = await o.db.question.findFirstOrThrow({ where: { runId: run.id } });
    expect(q).toMatchObject({ kind: 'login', input: 'takeover' });
    expect(q.prompt).toContain('not a password field');
    expect(q.prompt).not.toMatch(/^Warning/);
    // It says nothing against the provider's connection.
    expect(seam.outcome).not.toHaveBeenCalledWith(o.userId, expect.objectContaining({ ok: false }));
    const step = await prisma.runStep.findFirstOrThrow({ where: { runId: run.id, action: 'sign_in_with_saved_login' } });
    expect(step).toMatchObject({ ok: false, summary: 'the field is not a password field: the saved password was not typed' });

    // The owner signs in or looks; the model then names the password field itself and it is typed (the same password is not blocked).
    fabric.answer([...fabric.handoffs.values()][0]!, {});
    expect(await runner.advance(run.id, o.userId, null)).toBe('succeeded');
    expect(a.outputs[2]).toMatch(/Typed (username and )?password of the saved login login-1/);
    expect(fabric.typed().map((c) => c.op)).toEqual(['release']);
    for (const v of PASSWORDS) {
      expect((await everythingAbout(run.id)).stored).not.toContain(v);
      expect(a.outputs.join('\n')).not.toContain(v);
    }
  });
});

describe('saved logins: the authenticator code', () => {
  it('type_saved_code types the code of a login that has one, fresh, and records no value', async () => {
    const o = await owner('code');
    const fabric = fakeSecretsFabric(LOGIN_PAGE);
    const a = scriptedAi([[lookup, signIn(), ['type_saved_code', { ref: 'login-1', selector: '#otp', submit: true }], finish()]]);
    const run = await o.newRun();
    expect(await runnerOf(fabric, a.ai, secretsSeam().seam).advance(run.id, o.userId, null)).toBe('succeeded');
    expect(fabric.actions.filter((x) => x.type === 'type_code_from_provider')).toEqual([expect.objectContaining({ item_id: FIXTURE.itemId, selector: '#otp', submit: true, run_id: run.id })]);
    expect(fabric.typed().map((c) => c.op)).toEqual(['release', 'release', 'one_time_code']);
    const steps = await prisma.runStep.findMany({ where: { runId: run.id, action: 'type_saved_code' } });
    expect(steps).toEqual([expect.objectContaining({ ok: true, summary: "typed the authenticator code of the saved login 'Example login' (username p•••@example.test)" })]);
    const seen = await everythingAbout(run.id);
    for (const v of PASSWORDS) expect(seen.stored).not.toContain(v);
  });

  it('refuses a login without a code, and a text-message code still asks the owner', async () => {
    const o = await owner('nocode');
    const fabric = fakeSecretsFabric(FIXTURE.siteOrigin + '/login');
    const a = scriptedAi([
      [lookup, ['type_saved_code', { ref: 'login-1', selector: '#otp', submit: true }], ['request_human', { kind: 'code', prompt: 'Enter the code the site texted you', input: 'secret', choices: null, options: null, remember_label: null }]],
    ]);
    const run = await o.newRun();
    expect(await runnerOf(fabric, a.ai, secretsSeam().seam).advance(run.id, o.userId, null)).toBe('waiting_human');
    // The only login for this address is the one without a code.
    expect(a.outputs[0]).toContain('"hasCode":false');
    expect(a.outputs[1]).toContain('That login has no authenticator code saved');
    expect(fabric.typed()).toEqual([]);
    expect([...fabric.handoffs.values()][0]).toMatchObject({ input: 'secret', kind: 'code' });
  });

  it('a code is tried at most three times per login in a run', async () => {
    const o = await owner('codecap');
    const fabric = fakeSecretsFabric(LOGIN_PAGE);
    const code: Call = ['type_saved_code', { ref: 'login-1', selector: '#otp', submit: true }];
    const a = scriptedAi([[lookup, code, code, code, code]]);
    const run = await o.newRun();
    await runnerOf(fabric, a.ai, secretsSeam().seam).advance(run.id, o.userId, null);
    expect(fabric.typed().filter((c) => c.op === 'one_time_code')).toHaveLength(3);
    expect(a.outputs[4]).toContain('already typed 3 times in this run');
  });
});

describe('saved logins: a rejected password is not retried', () => {
  it('types the password once per login and site in a run: the second request is refused and sends the model to the owner', async () => {
    const o = await owner('rejected');
    const fabric = fakeSecretsFabric(LOGIN_PAGE);
    const a = scriptedAi([[lookup, signIn(), lookup, signIn(), credentials()]]);
    const run = await o.newRun();
    expect(await runnerOf(fabric, a.ai, secretsSeam().seam).advance(run.id, o.userId, null)).toBe('waiting_human');
    expect(a.outputs[3]).toContain("That login's password was already typed in this run");
    expect(a.outputs[3]).toContain('do not try it again');
    expect(fabric.typed().filter((c) => c.field === 'password')).toHaveLength(1);
    expect(await prisma.runStep.count({ where: { runId: run.id, ok: false, summary: 'refused: the password was already typed in this run' } })).toBe(1);
  });
});

describe('saved logins: unattended runs keep asking before a payment', () => {
  const pay: Call = ['click', { selector: '#pay', reason: 'finish' }];

  it('a scheduled run that signed in is stopped at "Pay" although the task has confirmation off', async () => {
    const o = await owner('unattended');
    const a = scriptedAi([[lookup, signIn(), pay]]);
    const run = await o.newRun({ trigger: 'schedule' });
    const fabric = fakeSecretsFabric(LOGIN_PAGE);
    await runnerOf(fabric, a.ai, secretsSeam().seam).advance(run.id, o.userId, null);
    expect(a.outputs[2]).toMatch(/^Refused: .*payment step/);
    expect(fabric.actions.filter((x) => x.type === 'click')).toEqual([]);
    expect(a.inputs[0]).not.toContain('nobody is watching');
  });

  it('a run that did not sign in is not asked, with confirmation off', async () => {
    const o = await owner('unattended-nosignin');
    const a = scriptedAi([[pay]]);
    const run = await o.newRun({ trigger: 'schedule' });
    const fabric = fakeSecretsFabric(LOGIN_PAGE);
    await runnerOf(fabric, a.ai, secretsSeam().seam).advance(run.id, o.userId, null);
    expect(a.outputs[0]).not.toMatch(/Refused/);
    expect(fabric.actions.filter((x) => x.type === 'click')).toHaveLength(1);
  });

  it("unattendedPayments: 'allow' leaves the task's own setting: not asked", async () => {
    const o = await owner('unattended-allow', { unattendedPayments: 'allow' });
    const a = scriptedAi([[lookup, signIn(), pay]]);
    const run = await o.newRun({ trigger: 'schedule' });
    const fabric = fakeSecretsFabric(LOGIN_PAGE);
    await runnerOf(fabric, a.ai, secretsSeam().seam).advance(run.id, o.userId, null);
    expect(a.outputs[2]).not.toMatch(/Refused/);
    expect(fabric.actions.filter((x) => x.type === 'click')).toHaveLength(1);
  });

  it('allow does not turn off a confirmation the task asked for', async () => {
    const o = await owner('unattended-allow-confirm', { unattendedPayments: 'allow', confirmRiskyActions: true });
    const a = scriptedAi([[lookup, signIn(), pay]]);
    const run = await o.newRun({ trigger: 'schedule' });
    await runnerOf(fakeSecretsFabric(LOGIN_PAGE), a.ai, secretsSeam().seam).advance(run.id, o.userId, null);
    expect(a.outputs[2]).toMatch(/^Refused/);
  });

  it('the owner is in the chat: a chat run is not asked more than its own setting says', async () => {
    const { userId } = await login(`saved-chat-pay-${stamp}@example.test`);
    const db = prisma.forUser({ userId });
    const chat = await db.conversation.create({ data: { userId, title: 'Pay', useSavedLogins: true, confirmRiskyActions: false } });
    const run = await db.run.create({ data: { userId, conversationId: chat.id, trigger: 'chat', goal: 'Pay' } });
    const a = scriptedAi([[lookup, signIn(), pay]]);
    const fabric = fakeSecretsFabric(LOGIN_PAGE);
    await runnerOf(fabric, a.ai, secretsSeam().seam).advance(run.id, userId, null);
    expect(a.outputs[2]).not.toMatch(/Refused/);
  });

  it('the first use tells the model, once, that the server now asks before a commitment', async () => {
    const o = await owner('unattended-line');
    const a = scriptedAi([[lookup, signIn()], [finish()]]);
    const run = await o.newRun({ trigger: 'api' });
    const runner = runnerOf(fakeSecretsFabric(LOGIN_PAGE), a.ai, secretsSeam().seam);
    await runner.advance(run.id, o.userId, null);
    expect(a.inputs[1] ?? '').toContain('nobody is watching');
  });
});

describe('saved logins: one notification per scheduled run', () => {
  it('a scheduled run that signed in notifies once, by site; a manual run does not', async () => {
    const o = await owner('notify');
    notifier.savedLoginUsed.mockClear();
    const a = scriptedAi([[lookup, signIn(), finish()]]);
    const run = await o.newRun({ trigger: 'schedule' });
    await runnerOf(fakeSecretsFabric(LOGIN_PAGE), a.ai, secretsSeam().seam).advance(run.id, o.userId, null);
    expect(notifier.savedLoginUsed).toHaveBeenCalledTimes(1);
    expect(notifier.savedLoginUsed.mock.calls[0]![2]).toEqual(['login.example.test']);

    notifier.savedLoginUsed.mockClear();
    const b = scriptedAi([[lookup, signIn(), finish()]]);
    const manual = await o.newRun({ trigger: 'manual' });
    await runnerOf(fakeSecretsFabric(LOGIN_PAGE), b.ai, secretsSeam().seam).advance(manual.id, o.userId, null);
    expect(notifier.savedLoginUsed).not.toHaveBeenCalled();
  });
});

describe('saved logins: crash safety', () => {
  it('a crash between the two fields does not type the username again, and a password that may be typed is not typed twice', async () => {
    const o = await owner('crash');
    const fabric = fakeSecretsFabric(LOGIN_PAGE);
    fabric.state.crashOn = 'password';
    const a = scriptedAi([[lookup, signIn()], [lookup, signIn(), credentials()]]);
    const run = await o.newRun();
    const runner = runnerOf(fabric, a.ai, secretsSeam().seam);

    // The process dies while the password is being typed: the job fails and is retried.
    await expect(runner.advance(run.id, o.userId, null)).rejects.toThrow('the process crashed');
    const saved = (await prisma.run.findFirstOrThrow({ where: { id: run.id } })).transcript as { savedLogins?: { attempt?: Record<string, unknown> } };
    expect(saved.savedLogins!.attempt).toMatchObject({ username: 'typed', password: 'typing' });
    // The phases are in the trace: before each field.
    const phases = await prisma.runStep.findMany({ where: { runId: run.id, action: 'saved_login_phase' }, orderBy: { seq: 'asc' } });
    expect(phases.map((s) => s.summary)).toEqual([
      "typing the username of the saved login 'Example login' (username p•••@example.test)",
      "typing the password of the saved login 'Example login' (username p•••@example.test)",
    ]);

    // The retry: the username is not typed again, the password is not typed blindly again, and the model is told.
    expect(await runner.advance(run.id, o.userId, null)).toBe('waiting_human');
    expect(fabric.typed().map((c) => c.field)).toEqual(['username', 'password']);
    expect(a.inputs[1]).toContain('cut off while it was typing');
    expect(a.outputs.at(-2)).toContain('cut off while typing this login');
    expect(a.outputs.at(-1)).toContain('Waiting for the person');
  });
});

describe('saved logins: the owner\'s defaults (API)', () => {
  const call = (token: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload: payload as object }) });

  it('new tasks and chats start from secrets.defaultUseSavedLogins, off unless the owner turned it on; each keeps its own switch', async () => {
    const { token, userId } = await login(`saved-defaults-${stamp}@example.test`);
    const body = { name: 'Check', goal: 'Check the account' };
    const created = (await call(token, 'POST', '/api/tasks', body)).json<{ data: { id: string; useSavedLogins: boolean; unattendedPayments: string } }>().data;
    expect(created).toMatchObject({ useSavedLogins: false, unattendedPayments: 'ask' });
    const chat = (await call(token, 'POST', '/api/chats', {})).json<{ data: { useSavedLogins: boolean } }>().data;
    expect(chat.useSavedLogins).toBe(false);

    expect((await call(token, 'PATCH', '/api/user-settings', { secrets: { defaultUseSavedLogins: true } })).statusCode).toBe(200);
    expect(await prisma.userSettings.findUnique({ where: { userId } })).toMatchObject({ value: { secrets: { defaultUseSavedLogins: true } } });
    const on = (await call(token, 'POST', '/api/tasks', body)).json<{ data: { id: string; useSavedLogins: boolean } }>().data;
    expect(on.useSavedLogins).toBe(true);
    expect((await call(token, 'POST', '/api/tasks', { ...body, useSavedLogins: false })).json<{ data: { useSavedLogins: boolean } }>().data.useSavedLogins).toBe(false);
    const chatOn = (await call(token, 'POST', '/api/chats', {})).json<{ data: { id: string; useSavedLogins: boolean } }>().data;
    expect(chatOn.useSavedLogins).toBe(true);

    // The switch of a task and of a chat, and unattendedPayments.
    const patched = (await call(token, 'PATCH', `/api/tasks/${on.id}`, { useSavedLogins: false, unattendedPayments: 'allow' })).json<{ data: { useSavedLogins: boolean; unattendedPayments: string } }>().data;
    expect(patched).toMatchObject({ useSavedLogins: false, unattendedPayments: 'allow' });
    expect((await call(token, 'POST', '/api/tasks', { ...body, unattendedPayments: 'sometimes' })).statusCode).toBe(400);
    const chatPatched = (await call(token, 'PATCH', `/api/chats/${chatOn.id}`, { useSavedLogins: false })).json<{ data: { useSavedLogins: boolean } }>().data;
    expect(chatPatched.useSavedLogins).toBe(false);
    // A chat's switch is carried over to the task drafted from it.
    const full = (await call(token, 'GET', `/api/chats/${chatOn.id}`)).json<{ data: { useSavedLogins: boolean } }>().data;
    expect(full.useSavedLogins).toBe(false);

    // Turning the default off again stores nothing.
    await call(token, 'PATCH', '/api/user-settings', { secrets: { defaultUseSavedLogins: false } });
    expect((await call(token, 'POST', '/api/tasks', body)).json<{ data: { useSavedLogins: boolean } }>().data.useSavedLogins).toBe(false);
  });
});
