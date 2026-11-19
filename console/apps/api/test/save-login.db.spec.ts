// "Save this login?" (E37.4b) against a real database: after the owner signs in by hand through a `credentials` card, the
// agent offers to save that login; on Save the FABRIC sends the password it still holds to the provider (here the fake Vault,
// contract 1.3), and the console stores none of it.
//
// What this proves: the offer is made once, after a sign-in the owner typed and the model saw succeed (never a failed one,
// never a saved-login one); Save reaches the fake Vault with the typed password and purpose `save_login` while no table of the
// console holds it; after the password's lifetime the card is "too late"; "Never for this site" suppresses later offers for
// that domain only; a taken name asks for another; a hosted app, a webhook, a notification action, the CLI and MCP cannot
// answer it; the run does not wait for it.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';
import { UserSettingsService } from '@marinoscar/platform-api/settings';

import { ChatService } from '../src/chat/chat.service';
import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { WebhookQuestionChannel } from '../src/questions/channels/webhook.channel';
import { QuestionEvents } from '../src/questions/question-events';
import { SAVE_LOGIN_PROMPT, QuestionsService, type QuestionView } from '../src/questions/questions.service';
import { GoalRunnerService } from '../src/runner/goal-runner.service';
import { RunSecretsService } from '../src/secrets/run-secrets.service';
import { SaveLoginService } from '../src/secrets/save-login.service';
import { SecretsEvents } from '../src/secrets/secrets.events';
import { TasksService } from '../src/tasks/tasks.service';
import { fakeSecretsFabric, type SecretsFabric } from './support/fake-secrets-fabric';
import { startFakeVault, type FakeVault } from './support/fake-vault';

let app: NestFastifyApplication;
let prisma: PrismaService;
let vault: FakeVault;
const stamp = `${Date.now()}`;
// A real top-level domain: the registrable domain of an invented `.test` host is the host itself (it is not on the public suffix list).
const ORIGIN = 'https://login.example.com';
const LOGIN_PAGE = `${ORIGIN}/signin`;
const USERNAME = 'person-a@example.test';
/** The password the owner types: a canary the console must never hold. */
const PASSWORD = `CANARY-typed-by-hand-${stamp}-7c1d9e`;
const WRITE_SCOPES = ['vault:items_read', 'vault:items_fill', 'vault:items_write'];

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  vault = await startFakeVault();
});
afterAll(async () => {
  await vault?.stop();
  await app?.close();
});

async function login(email: string): Promise<{ userId: string; token: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { userId: me.json<{ data: { id: string } }>().data.id, token };
}

type Call = [name: string, args: Record<string, unknown>];
/** A step of a script: a tool call, or something that happens on the page between two calls. */
type Step = Call | (() => void);
type Tools = { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> }[];

/** A model that makes the scripted tool calls, one script per round. */
function scriptedAi(scripts: Step[][]) {
  const outputs: string[] = [];
  const toolNames: string[][] = [];
  const runTools = jest.fn(async (req: { tools: Tools; onStep?: (s: unknown) => void }) => {
    toolNames.push(req.tools.map((t) => t.tool.name));
    const script = scripts.shift() ?? [];
    let step = 0;
    for (const entry of script) {
      if (typeof entry === 'function') {
        entry();
        continue;
      }
      const [name, args] = entry;
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
  return { ai: { forUser: () => ({ runTools }) } as unknown as AiService, outputs, toolNames };
}

const credentials: Call = ['request_human', { kind: 'login', prompt: 'Sign in to Example', input: 'credentials', choices: null, options: null, remember_label: null }];
const typeUser: Call = ['type_text', { selector: '#user', text: USERNAME, submit: false }];
const typePassword: Call = ['type_handoff_secret', { selector: '#pw', submit: true, parameter: null }];
const propose = (name = 'Example sign-in'): Call => ['propose_saving_login', { name }];
const finish: Call = ['finish', { success: true, result: 'Done.' }];

const notifier = { finished: jest.fn(), needsYou: jest.fn(), started: jest.fn(), savedLoginUsed: jest.fn(), savedApprovalsUsed: jest.fn() };

/** One owner's world: the in-memory fabric (holding the password as the real one does), the real broker and the Save carried out through them. */
function world(opts: { supported?: boolean; page?: string } = {}) {
  const fabric: SecretsFabric = fakeSecretsFabric(opts.page ?? LOGIN_PAGE);
  fabric.state.vault = { baseUrl: vault.baseUrl, token: vault.directAccessToken(WRITE_SCOPES) };
  const questions = new QuestionsService(prisma, fabric.client, { enqueue: async () => undefined } as never, new QuestionEvents());
  const registrar = { ensureRegistered: jest.fn(async () => 'registered') };
  const connection = { recordOutcome: jest.fn(async () => undefined) };
  const saveLogins = new SaveLoginService(prisma, undefined as never, connection as never, undefined as never, undefined as never, registrar as never, fabric.client, app.get(SecretsEvents, { strict: false }), questions, app.get(UserSettingsService, { strict: false }));
  saveLogins.onModuleInit();
  const supported = jest.fn(async () => opts.supported ?? true);
  const seam = {
    prepare: async () => 'registered',
    outcome: async () => undefined,
    saveLoginSupported: supported,
    proposeSaveLogin: (userId: string, args: Parameters<SaveLoginService['propose']>[1]) => saveLogins.propose(userId, args),
  } as unknown as RunSecretsService;
  const runnerWith = (ai: AiService) => {
    const r = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, notifier as never, questions);
    r.secrets = seam;
    return r;
  };
  return { fabric, questions, registrar, connection, saveLogins, supported, runnerWith };
}
type World = ReturnType<typeof world>;

/** An owner with a task that may use saved logins. */
async function owner(label: string) {
  const { userId, token } = await login(`savelogin-${label}-${stamp}@example.test`);
  const db = prisma.forUser({ userId });
  const task = await db.task.create({ data: { userId, name: `Sign in ${label}`, goal: 'Check the account', useSavedLogins: true, confirmRiskyActions: false } });
  const newRun = (data: Record<string, unknown> = {}) => db.run.create({ data: { userId, taskId: task.id, goal: 'Check the account', ...data } });
  return { userId, token, db, task, newRun };
}
type Owner = Awaited<ReturnType<typeof owner>>;

/**
 * The owner signs in by hand: the agent asks with a `credentials` card, the owner answers it (the password goes to the fabric,
 * which holds it), the agent types it and says it is signed in. Returns the run and the card that was offered, if any.
 */
async function signedIn(o: Owner, w: World, opts: { name?: string; calls?: Step[] } = {}) {
  const run = await o.newRun();
  const first = scriptedAi([[credentials]]);
  const runner = w.runnerWith(first.ai);
  expect(await runner.advance(run.id, o.userId, null)).toBe('waiting_human');
  await w.questions.answerRun({ id: o.userId }, run.id, { outcome: 'completed', value: USERNAME, secret: PASSWORD }, { channel: 'web' });
  const second = scriptedAi([[typeUser, typePassword, ...(opts.calls ?? [propose(opts.name)]), finish]]);
  expect(await w.runnerWith(second.ai).advance(run.id, o.userId, null)).toBe('succeeded');
  const card = await prisma.question.findFirst({ where: { runId: run.id, input: 'save_login' } });
  return { run, card, outputs: second.outputs, first, second };
}

/** Every table of the console that holds `marker` anywhere in a row: a scan of the whole database. */
async function tablesHolding(marker: string): Promise<string[]> {
  const tables = await prisma.$queryRawUnsafe<{ table_name: string }[]>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
  const found: string[] = [];
  for (const { table_name } of tables) {
    const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table_name}" t WHERE t::text LIKE $1`, `%${marker}%`);
    if ((rows[0]?.n ?? 0) > 0) found.push(table_name);
  }
  return found;
}

const rejected = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    const r = e as { status?: number; getStatus?: () => number; getResponse?: () => { code?: string; message?: string } };
    return { status: r.getStatus?.() ?? r.status, ...(r.getResponse?.() ?? {}) };
  }
  throw new Error('expected a rejection');
};

describe('offering to save a sign-in the owner typed', () => {
  it('offers it once, after the model saw the sign-in succeed; the card names the site, the name and the username, and the run does not wait for it', async () => {
    const o = await owner('offer');
    const w = world();
    const { run, card, outputs, first, second } = await signedIn(o, w, { calls: [propose('Example sign-in'), propose('Again')] });

    // The tool exists only because a Vault with the write scope speaks contract 1.3, and the `credentials` card asked the fabric to keep the password.
    expect(first.toolNames[0]).toContain('request_human');
    expect(second.toolNames[0]).toContain('propose_saving_login');
    expect([...w.fabric.handoffs.values()][0]).toMatchObject({ input: 'credentials', offerSave: true });

    expect(outputs).toEqual(['ok', 'Typed the secret.', 'Offered; the owner decides. The run does not wait for the answer.', 'Already offered for this sign-in.', 'Finished.']);
    // One card, not blocking: the run finished with it still pending.
    expect(await prisma.question.count({ where: { runId: run.id, input: 'save_login' } })).toBe(1);
    expect(card).toMatchObject({ input: 'save_login', kind: 'login', blocking: false, status: 'pending', prompt: SAVE_LOGIN_PROMPT, runId: run.id });
    expect((await prisma.run.findFirstOrThrow({ where: { id: run.id } })).status).toBe('succeeded');
    // What it holds: the site the sign-in page was on as the fabric reported it, the owner's username, the suggested name. Not the password.
    expect(card!.proposal).toMatchObject({ site: 'login.example.com', origin: ORIGIN, domain: 'example.com', name: 'Example sign-in', username: USERNAME, provider: 'vault' });
    expect(JSON.stringify(card)).not.toContain(PASSWORD);
    // It lives while the fabric holds the password: ten minutes after the answer.
    const answered = (await prisma.question.findFirstOrThrow({ where: { runId: run.id, input: 'credentials' } })).answeredAt!;
    expect(card!.expiresAt.getTime() - answered.getTime()).toBeGreaterThan(9 * 60_000);
    expect(card!.expiresAt.getTime() - answered.getTime()).toBeLessThanOrEqual(10 * 60_000 + 5_000);
    // The view the card is drawn from carries the facts and not the fabric's handoff.
    const view = await w.questions.get(o.userId, card!.id);
    expect(view).toMatchObject({ input: 'save_login', blocking: false, saveLogin: { site: 'login.example.com', domain: 'example.com', name: 'Example sign-in', username: USERNAME } });
    expect(JSON.stringify(view)).not.toContain(String((card!.proposal as { handoffId: string }).handoffId));
    // Nothing was saved by offering.
    expect(w.fabric.saves).toEqual([]);
    expect(vault.logins.find((l) => l.name === 'Example sign-in')).toBeUndefined();
  });

  it('never offers a sign-in that failed (the page still asks for a password), and offers it once the page moved on', async () => {
    const o = await owner('failed');
    const w = world();
    w.fabric.page.passwordShown = true;
    const { run, card, outputs } = await signedIn(o, w, {
      calls: [propose(), () => void (w.fabric.page.passwordShown = false), propose()],
    });
    // The first call is refused and is not "the offer": the model may call again once it sees the account.
    expect(outputs[2]).toMatch(/still shows a password field/);
    expect(outputs[3]).toMatch(/^Offered/);
    expect(card).not.toBeNull();
    expect(await prisma.question.count({ where: { runId: run.id, input: 'save_login' } })).toBe(1);

    // A sign-in that never gets past the form is never offered.
    const failed = world();
    failed.fabric.page.passwordShown = true;
    const second = await signedIn(await owner('failed2'), failed);
    expect(second.outputs[2]).toMatch(/still shows a password field/);
    expect(second.card).toBeNull();
  });

  it('never offers a sign-in the agent did not type from the owner\'s card: a saved-login sign-in, or nothing at all', async () => {
    const o = await owner('saved');
    const w = world();
    const run = await o.newRun();
    const a = scriptedAi([[['saved_logins', {}], ['sign_in_with_saved_login', { ref: 'login-1', username_selector: '#user', password_selector: '#pw', submit: true }], propose(), finish]]);
    expect(await w.runnerWith(a.ai).advance(run.id, o.userId, null)).toBe('succeeded');
    expect(a.outputs[2]).toMatch(/^Nothing to offer/);
    expect(await prisma.question.count({ where: { runId: run.id, input: 'save_login' } })).toBe(0);
    expect(w.fabric.handoffs.size).toBe(0);
  });

  it('is not offered, and the fabric is not asked to keep the password, without a Vault that can save (no write scope, or older than contract 1.3)', async () => {
    const o = await owner('unsupported');
    const w = world({ supported: false });
    const run = await o.newRun();
    const a = scriptedAi([[credentials]]);
    expect(await w.runnerWith(a.ai).advance(run.id, o.userId, null)).toBe('waiting_human');
    expect(a.toolNames[0]).not.toContain('propose_saving_login');
    expect([...w.fabric.handoffs.values()][0]).toMatchObject({ input: 'credentials' });
    expect([...w.fabric.handoffs.values()][0]).not.toHaveProperty('offerSave');
    // The saved-logins switch off: not even asked.
    const off = await owner('off');
    await off.db.task.update({ where: { id: off.task.id }, data: { useSavedLogins: false } });
    const w2 = world();
    expect(await w2.runnerWith(scriptedAi([[credentials]]).ai).advance((await off.newRun()).id, off.userId, null)).toBe('waiting_human');
    expect(w2.supported).not.toHaveBeenCalled();
  });

  it('puts the card in the thread of the chat whose run signed in', async () => {
    const { userId } = await login(`savelogin-chat-${stamp}@example.test`);
    const chat = await app.get(ChatService, { strict: false }).create(userId, {});
    await prisma.conversation.update({ where: { id: chat.id }, data: { useSavedLogins: true } });
    const w = world();
    const run = await prisma.forUser({ userId }).run.create({ data: { userId, conversationId: chat.id, goal: 'Check the account' } });
    expect(await w.runnerWith(scriptedAi([[credentials]]).ai).advance(run.id, userId, null)).toBe('waiting_human');
    await w.questions.answerRun({ id: userId }, run.id, { outcome: 'completed', value: USERNAME, secret: PASSWORD }, { channel: 'web' });
    await w.runnerWith(scriptedAi([[typeUser, typePassword, propose(), finish]]).ai).advance(run.id, userId, null);
    const card = await prisma.question.findFirstOrThrow({ where: { runId: run.id, input: 'save_login' } });
    expect(card.conversationId).toBe(chat.id);
    const message = await prisma.chatMessage.findFirstOrThrow({ where: { conversationId: chat.id, kind: 'memory' } });
    expect(message.meta).toEqual({ questionId: card.id, card: 'save_login' });
    expect(message.text).toBe('Offered to save the sign-in for login.example.com');
  });
});

describe('Save', () => {
  it('sends the password the fabric still holds to the provider, and the console stores none of it', async () => {
    const o = await owner('save');
    const w = world();
    const { run, card } = await signedIn(o, w);
    const before = vault.requests.length;

    const view = await w.questions.answer({ id: o.userId }, card!.id, { outcome: 'completed', saveLogin: { name: 'Example sign-in (mine)' } }, { channel: 'web' });
    expect(view).toMatchObject({ status: 'answered', input: 'save_login', response: { outcome: 'completed', savedAs: 'Example sign-in (mine)', channel: 'web', valueWithheld: false } });

    // The registration was renewed first (the run that held it is over), then the fabric was asked: ids and names, never a value.
    expect(w.registrar.ensureRegistered).toHaveBeenCalledWith(o.userId, { force: true });
    expect(w.fabric.saves).toEqual([{ owner: o.userId, provider: 'vault', handoffId: (card!.proposal as { handoffId: string }).handoffId, name: 'Example sign-in (mine)', origin: ORIGIN, runId: run.id, clientLabel: 'Hexactra' }]);
    expect(JSON.stringify(w.fabric.request.mock.calls.filter((c) => String(c[1]).endsWith('/save-login')))).not.toContain(PASSWORD);

    // The fake Vault got the login: the owner's name and username, bound to the sign-in page's origin, the password they typed, opened to agents, with purpose save_login.
    const saved = vault.logins.find((l) => l.name === 'Example sign-in (mine)')!;
    expect(saved).toMatchObject({ username: USERNAME, password: PASSWORD, origins: [ORIGIN], open: true });
    const creates = vault.requests.slice(before).filter((r) => r.method === 'POST' && r.path === '/api/agent/v1/credentials');
    expect(creates).toEqual([expect.objectContaining({ status: 201, params: { origin: ORIGIN, purpose: 'save_login' } })]);

    // The offer was used: pressing Save again is a settled question, and the fabric is not asked again.
    expect((await rejected(w.questions.answer({ id: o.userId }, card!.id, { outcome: 'completed', saveLogin: { name: 'Twice' } }, { channel: 'web' })))).toMatchObject({ status: 409, code: 'ALREADY_ANSWERED' });
    expect(w.fabric.saves).toHaveLength(1);

    // THE scan: no table of the console holds the password, the audit trail says what happened without it.
    expect(await tablesHolding(PASSWORD)).toEqual([]);
    const audit = await prisma.auditEvent.findMany({ where: { actorUserId: o.userId, action: { startsWith: 'secrets.login.' } } });
    expect(audit.map((a) => a.action).sort()).toEqual(['secrets.login.offered', 'secrets.login.saved']);
    expect(JSON.stringify(audit)).not.toMatch(new RegExp(`${PASSWORD}|${USERNAME}|Example sign-in`));
    expect(audit.find((a) => a.action === 'secrets.login.saved')!.meta).toEqual({ provider: 'vault', site: 'login.example.com' });
  });

  it('a name the owner already has asks for another name and keeps the card; the password is still held for the second try', async () => {
    const o = await owner('taken');
    const w = world();
    const { card } = await signedIn(o, w);
    const taken = await rejected(w.questions.answer({ id: o.userId }, card!.id, { outcome: 'completed', saveLogin: { name: 'Shop login' } }, { channel: 'web' }));
    expect(taken).toMatchObject({ status: 409, code: 'SAVE_NAME_TAKEN' });
    expect(taken.message).toMatch(/Choose another name/);
    expect(await prisma.question.findFirstOrThrow({ where: { id: card!.id } })).toMatchObject({ status: 'pending', response: null, answeredAt: null });
    expect(vault.logins.filter((l) => l.name === 'Shop login')).toHaveLength(1);
    // Another name works, with the same password.
    const done = await w.questions.answer({ id: o.userId }, card!.id, { outcome: 'completed', saveLogin: { name: `Shop login ${stamp}` } }, { channel: 'web' });
    expect(done.status).toBe('answered');
    expect(vault.logins.find((l) => l.name === `Shop login ${stamp}`)!.password).toBe(PASSWORD);
    expect(w.fabric.saves).toHaveLength(2);
  });

  it('too late once the fabric no longer holds the password: the card says so, nothing is saved, and it is offered at the next sign-in', async () => {
    const o = await owner('late');
    const w = world();
    const { card } = await signedIn(o, w);
    // The fabric dropped it (its ten minutes passed, or it restarted) before the question's own deadline.
    const h = [...w.fabric.handoffs.values()][0]!;
    h.offer!.expiresAt = Date.now() - 1;
    const count = vault.logins.length;
    const late = await rejected(w.questions.answer({ id: o.userId }, card!.id, { outcome: 'completed', saveLogin: { name: 'Too late sign-in' } }, { channel: 'web' }));
    expect(late).toMatchObject({ status: 409, code: 'SAVE_TOO_LATE', message: 'Too late to save this time; it will be offered at the next sign-in.' });
    expect(vault.logins).toHaveLength(count);
    // Settled as expired, so the card reads "too late", not as a question still waiting.
    expect(await prisma.question.findFirstOrThrow({ where: { id: card!.id } })).toMatchObject({ status: 'expired', response: null });
    expect((await w.questions.get(o.userId, card!.id)).status).toBe('expired');

    // And when the question's own deadline passes, a late press is an expired question.
    const o2 = await owner('late2');
    const w2 = world();
    const second = await signedIn(o2, w2);
    await prisma.question.update({ where: { id: second.card!.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    expect(await rejected(w2.questions.answer({ id: o2.userId }, second.card!.id, { outcome: 'completed', saveLogin: { name: 'Late' } }, { channel: 'web' }))).toMatchObject({ status: 409, code: 'QUESTION_EXPIRED' });
    expect(w2.fabric.saves).toEqual([]);
    expect((await w2.questions.get(o2.userId, second.card!.id)).status).toBe('expired');
  });

  it('says what to do when the Vault refuses (the connection, the switch, the permission) and keeps the card to try again', async () => {
    const o = await owner('refused');
    const w = world();
    const { card } = await signedIn(o, w);
    const cases: [string, number, string, RegExp][] = [
      ['unauthorized', 502, 'SAVE_RECONNECT', /Reconnect it/],
      ['disabled', 422, 'SAVE_DISABLED', /switched off/],
      ['unavailable', 502, 'SAVE_UNAVAILABLE', /could not be reached/],
      ['refused', 422, 'SAVE_REFUSED', /save and change logins.*1\.3/],
    ];
    for (const [code, status, expected, words] of cases) {
      w.fabric.state.failSave = { status, code };
      const e = await rejected(w.questions.answer({ id: o.userId }, card!.id, { outcome: 'completed', saveLogin: { name: 'Example sign-in' } }, { channel: 'web' }));
      expect(e).toMatchObject({ code: expected });
      expect(e.message).toMatch(words);
      expect((await prisma.question.findFirstOrThrow({ where: { id: card!.id } })).status).toBe('pending');
    }
    // A registration that cannot be renewed: the owner is told to reconnect.
    w.fabric.state.failSave = null;
    w.registrar.ensureRegistered.mockResolvedValueOnce('needs_reconnect');
    expect(await rejected(w.questions.answer({ id: o.userId }, card!.id, { outcome: 'completed', saveLogin: { name: 'Example sign-in' } }, { channel: 'web' }))).toMatchObject({ code: 'SAVE_RECONNECT' });
    // And the sign-in can still be saved once the Vault answers.
    expect((await w.questions.answer({ id: o.userId }, card!.id, { outcome: 'completed', saveLogin: { name: `Recovered ${stamp}` } }, { channel: 'web' })).status).toBe('answered');
    expect(vault.logins.find((l) => l.name === `Recovered ${stamp}`)!.password).toBe(PASSWORD);
    expect(w.connection.recordOutcome).toHaveBeenCalledWith(o.userId, { ok: false, code: 'UNAUTHORIZED' });
  });
});

describe('Not now and "Never for this site"', () => {
  it('Not now declines this offer only: nothing is saved and nothing is remembered', async () => {
    const o = await owner('notnow');
    const w = world();
    const { card } = await signedIn(o, w);
    const view = await w.questions.answer({ id: o.userId }, card!.id, { outcome: 'cancelled' }, { channel: 'web' });
    expect(view).toMatchObject({ status: 'cancelled', response: { outcome: 'cancelled' } });
    expect(view.response).not.toHaveProperty('neverForSite');
    expect(w.fabric.saves).toEqual([]);
    const row = await prisma.userSettings.findUnique({ where: { userId: o.userId } });
    expect(JSON.stringify(row?.value ?? {})).not.toContain('neverSaveLoginSites');
    // The next sign-in on the same site is offered again.
    const again = await signedIn(o, world());
    expect(again.card).not.toBeNull();
  });

  it('"Never for this site" is remembered per owner and registrable domain: no later offer on that domain, any other domain and any other owner still get one', async () => {
    const o = await owner('never');
    const w = world();
    const { card } = await signedIn(o, w);
    const view = await w.questions.answer({ id: o.userId }, card!.id, { outcome: 'cancelled', neverForSite: true }, { channel: 'web' });
    expect(view).toMatchObject({ status: 'cancelled', response: { outcome: 'cancelled', neverForSite: true } });
    expect(w.fabric.saves).toEqual([]);
    expect((await prisma.userSettings.findUniqueOrThrow({ where: { userId: o.userId } })).value).toMatchObject({ secrets: { neverSaveLoginSites: ['example.com'] } });
    expect(await prisma.auditEvent.count({ where: { actorUserId: o.userId, action: 'secrets.login.never_for_site' } })).toBe(1);

    // The same site again (another subdomain of the registrable domain too): the model is told, and no card is made.
    for (const page of [LOGIN_PAGE, 'https://accounts.example.com/login']) {
      const w2 = world({ page });
      const again = await signedIn(o, w2);
      expect(again.outputs[2]).toBe('The owner chose never to be asked to save a login for this site. Do not offer again.');
      expect(again.card).toBeNull();
    }
    // Another registrable domain of the same owner is still offered.
    const other = await signedIn(o, world({ page: 'https://signin.another-site.org/login' }));
    expect(other.card).toMatchObject({ status: 'pending' });
    expect((other.card!.proposal as { domain: string }).domain).toBe('another-site.org');
    // Another owner, the same site: still offered.
    const o2 = await owner('never-other');
    expect((await signedIn(o2, world())).card).not.toBeNull();
    // The owner can take the site off the list in their settings (a plain setting) and be asked again.
    await app.get(UserSettingsService, { strict: false }).patchSettings(o.userId, { secrets: { neverSaveLoginSites: [] } } as never);
    expect((await signedIn(o, world())).card).not.toBeNull();
  });
});

describe('who may answer the card', () => {
  async function pendingCard(label: string) {
    const o = await owner(label);
    const w = world();
    const { card } = await signedIn(o, w);
    return { o, w, card: card! };
  }

  it('a hosted app, a webhook, a notification action, MCP, the CLI and the REST API under another name cannot save or decline it; the card stays pending', async () => {
    const { o, w, card } = await pendingCard('channels');
    for (const channel of ['mcp-oauth', 'mcp-oauth.claude', 'mcp-app', 'mcp-elicitation', 'mcp', 'webhook', 'notification', 'cli', 'tui', 'api', 'unknown']) {
      for (const outcome of ['completed', 'cancelled'] as const) {
        const e = await rejected(w.questions.answer({ id: o.userId }, card.id, outcome === 'completed' ? { outcome, saveLogin: { name: 'X' } } : { outcome, neverForSite: true }, { channel }));
        expect({ channel, outcome, ...e }).toMatchObject({ status: 403, code: 'CHANNEL_NOT_ALLOWED' });
      }
    }
    expect(await prisma.question.findFirstOrThrow({ where: { id: card.id } })).toMatchObject({ status: 'pending', response: null });
    expect(w.fabric.saves).toEqual([]);
    expect(await prisma.userSettings.findUnique({ where: { userId: o.userId } }).then((r) => JSON.stringify(r?.value ?? {}))).not.toContain('neverSaveLoginSites');
  });

  it('over HTTP: another account cannot see or answer it, a hosted-app token cannot list it, and the web app can decline it; the webhook payload offers no way to answer and names nothing', async () => {
    const { o, w, card } = await pendingCard('http');
    // The owner, signed in, in the web app (the default REST channel is `api`, which is not a signed-in page: the web app says `web`).
    const as = (token: string) => ({ authorization: `Bearer ${token}` });
    const declinedFromApi = await app.inject({ method: 'POST', url: `/api/questions/${card.id}/cancel`, headers: as(o.token), payload: { channel: 'notification' } });
    expect(declinedFromApi.statusCode).toBe(403);
    expect(declinedFromApi.json<{ message: string }>().message).toMatch(/Saving a login is decided only in Hexactra, signed in.*notification button/);
    // The answer-by-token route is public and token-bound: nothing issues a token for this question, and it refuses a guess.
    const guess = await app.inject({ method: 'POST', url: `/api/questions/${card.id}/answer-by-token`, headers: { 'x-question-token': 'not-a-token' }, payload: { outcome: 'cancelled' } });
    expect(guess.statusCode).toBe(401);
    // The webhook and notification payloads carry no answer block, no value, no site and no name.
    const view: QuestionView = await w.questions.get(o.userId, card.id);
    const payload = await app.get(WebhookQuestionChannel, { strict: false }).askedPayload(view);
    expect(payload).not.toHaveProperty('answer');
    expect(JSON.stringify(payload)).not.toMatch(/example|person-a|login\.|username/i);
    // Another account: not found.
    const stranger = await login(`savelogin-stranger-${stamp}@example.test`);
    const read = await app.inject({ method: 'GET', url: `/api/questions/${card.id}`, headers: as(stranger.token) });
    expect(read.statusCode).toBe(404);
    const steal = await app.inject({ method: 'POST', url: `/api/questions/${card.id}/cancel`, headers: as(stranger.token), payload: { channel: 'web' } });
    expect(steal.statusCode).toBe(404);
    // The owner reads it, and declines it from the web app.
    const mine = await app.inject({ method: 'GET', url: `/api/questions/${card.id}`, headers: as(o.token) });
    expect(mine.json<{ data: { input: string; saveLogin: { site: string } } }>().data).toMatchObject({ input: 'save_login', saveLogin: { site: 'login.example.com' } });
    const inbox = await app.inject({ method: 'GET', url: '/api/inbox', headers: as(o.token) });
    expect(inbox.json<{ data: { questionId: string; input: string; blocking: boolean; saveLogin: { username: string } | null }[] }>().data.find((i) => i.questionId === card.id)).toMatchObject({ input: 'save_login', blocking: false, saveLogin: { username: USERNAME } });
    const declined = await app.inject({ method: 'POST', url: `/api/questions/${card.id}/cancel`, headers: as(o.token), payload: { channel: 'web' } });
    expect(declined.statusCode).toBe(200);
    expect(declined.json<{ data: { status: string } }>().data.status).toBe('cancelled');
  });
});
