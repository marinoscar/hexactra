// Hexactra passkeys in a run (E47.5, #943) against a real database: a scripted model, the in-memory fabric and the real question
// broker. The tools are offered only where saved sign-ins are on and the owner's provider keeps passkeys; sign_in_with_passkey tells
// the model only "signed in" or how to ask the owner; add_passkey asks the owner a high-risk card the server words, naming the site
// the browser is on, and makes a passkey only after the owner approves, once. A confirmation the model asks itself approves nothing.
// The owner's list and Remove are theirs only.
import './support/secrets-store-env';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AiService } from '@marinoscar/platform-api/ai';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { QuestionEvents } from '../src/questions/question-events';
import { QuestionsService } from '../src/questions/questions.service';
import { GoalRunnerService } from '../src/runner/goal-runner.service';
import { ADD_PASSKEY_PROMPT } from '../src/runner/host/tools/passkeys';
import { RunSecretsService } from '../src/secrets/run-secrets.service';
import { StorePasskeys } from '../src/secrets/builtin/store.passkeys';
import { TasksService } from '../src/tasks/tasks.service';
import { fakeSecretsFabric, type SecretsFabric } from './support/fake-secrets-fabric';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;
const PAGE = 'https://login.example.com/account/security';

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
function scriptedAi(scripts: Call[][]) {
  const outputs: string[] = [];
  const toolNames: string[][] = [];
  const runTools = jest.fn(async (req: { tools: Tools; onStep?: (s: unknown) => void }) => {
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
  return { ai: { forUser: () => ({ runTools }) } as unknown as AiService, outputs, toolNames };
}
const finish: Call = ['finish', { success: true, result: 'Done.' }];
const signIn: Call = ['sign_in_with_passkey', { selector: '#passkey' }];
const add: Call = ['add_passkey', { selector: '#add-passkey' }];
const notifier = { finished: jest.fn(), needsYou: jest.fn(), started: jest.fn(), savedLoginUsed: jest.fn(), savedApprovalsUsed: jest.fn() };

function seam(passkeys: boolean): RunSecretsService {
  return { prepare: jest.fn(async () => 'registered'), outcome: jest.fn(async () => undefined), saveLoginSupported: jest.fn(async () => false), passkeysSupported: jest.fn(async () => passkeys) } as unknown as RunSecretsService;
}
function runnerOf(fabric: SecretsFabric, ai: AiService, s: RunSecretsService) {
  const questions = new QuestionsService(prisma, fabric.client, { enqueue: async () => undefined } as never, new QuestionEvents());
  const r = new GoalRunnerService(prisma, app.get(TasksService), fabric.client, ai, notifier as never, questions);
  r.secrets = s;
  return { runner: r, questions };
}
async function owner(label: string, useSavedLogins = true) {
  const { userId, token } = await login(`pk-run-${label}-${stamp}@example.test`);
  const db = prisma.forUser({ userId });
  const t = await db.task.create({ data: { userId, name: `Passkey ${label}`, goal: 'Sign in', useSavedLogins, confirmRiskyActions: false } });
  return { userId, token, newRun: () => db.run.create({ data: { userId, taskId: t.id, goal: 'Sign in' } }) };
}
const passkeyActions = (f: SecretsFabric) => f.actions.filter((a) => String(a.type).startsWith('passkey_')).map((a) => a.type);

describe('Hexactra passkeys in a run (E47.5)', () => {
  it('offers the tools only with saved sign-ins on and a provider that keeps passkeys', async () => {
    for (const [label, opted, supported, offered] of [['on', true, true, true], ['nostore', true, false, false], ['optout', false, true, false]] as const) {
      const o = await owner(`offer-${label}`, opted);
      const a = scriptedAi([[finish]]);
      const run = await o.newRun();
      await runnerOf(fakeSecretsFabric(PAGE), a.ai, seam(supported)).runner.advance(run.id, o.userId, null);
      expect({ label, offered: a.toolNames[0]!.includes('sign_in_with_passkey') && a.toolNames[0]!.includes('add_passkey') }).toEqual({ label, offered });
    }
  });

  it('signs in, and the model reads only "signed in"; with no passkey it is told how to ask the owner', async () => {
    const o = await owner('signin');
    const fabric = fakeSecretsFabric(PAGE);
    const a = scriptedAi([[signIn, finish]]);
    const run = await o.newRun();
    expect(await runnerOf(fabric, a.ai, seam(true)).runner.advance(run.id, o.userId, null)).toBe('succeeded');
    expect(a.outputs[0]).toBe("Signed in with the owner's Hexactra passkey for example.com. Check the page.");
    expect(fabric.actions.find((x) => x.type === 'passkey_sign_in')).toMatchObject({ selector: '#passkey', run_id: run.id });

    const none = fakeSecretsFabric(PAGE);
    none.state.passkeys.signIn = 'no_passkey';
    const b = scriptedAi([[signIn, finish]]);
    const run2 = await o.newRun();
    await runnerOf(none, b.ai, seam(true)).runner.advance(run2.id, o.userId, null);
    expect(b.outputs[0]).toMatch(/no Hexactra passkey for this site.*input "scan", scan_source "desktop"/);
    const step = await prisma.runStep.findFirstOrThrow({ where: { runId: run2.id, action: 'sign_in_with_passkey' } });
    expect(step).toMatchObject({ ok: false, summary: 'no passkey sign-in: no_passkey' });
  });

  it('a payment approval is never signed: the model is told to have the owner confirm it (E47.6)', async () => {
    const o = await owner('payment');
    const fabric = fakeSecretsFabric(PAGE);
    fabric.state.passkeys.signIn = 'payment_refused';
    const a = scriptedAi([[signIn, finish]]);
    const run = await o.newRun();
    await runnerOf(fabric, a.ai, seam(true)).runner.advance(run.id, o.userId, null);
    expect(a.outputs[0]).toMatch(/approves a payment: Hexactra never does that\. Ask the owner to confirm it themselves \(request_human, kind "verification"/);
  });

  it('adds a passkey only after the owner approves the card the server words, for that site, once', async () => {
    const o = await owner('add');
    const fabric = fakeSecretsFabric(PAGE);
    // First call: a card, no passkey. Second (after the approval): the passkey. Third: a new approval is needed.
    const a = scriptedAi([[add], [add, add], [finish]]);
    const run = await o.newRun();
    const { runner } = runnerOf(fabric, a.ai, seam(true));
    expect(await runner.advance(run.id, o.userId, null)).toBe('waiting_human');
    expect(a.outputs[0]).toBe('Waiting for the owner to approve adding a Hexactra passkey for example.com.');
    expect(passkeyActions(fabric)).toEqual([]);
    const h = [...fabric.handoffs.values()][0]!;
    expect(h).toMatchObject({ kind: 'passkey', input: 'confirm', prompt: ADD_PASSKEY_PROMPT('example.com') });
    const q = await prisma.question.findFirstOrThrow({ where: { runId: run.id } });
    expect(q).toMatchObject({ kind: 'passkey', input: 'confirm', risk: 'high' });
    fabric.answer(h, { value: 'approve' });
    expect(await runner.advance(run.id, o.userId, null)).toBe('waiting_human');
    expect(a.outputs[1]).toBe('Added a Hexactra passkey for example.com (account person-a@example.test). Check that the site lists it.');
    expect(a.outputs[2]).toBe('Waiting for the owner to approve adding a Hexactra passkey for example.com.');
    expect(passkeyActions(fabric)).toEqual(['passkey_create']);
  });

  it('a decline, or a confirmation the model asks itself, adds nothing', async () => {
    const o = await owner('decline');
    const fabric = fakeSecretsFabric(PAGE);
    const ask: Call = ['request_human', { kind: 'passkey', prompt: 'Add a passkey?', input: 'confirm', choices: null, options: null, constraints: null, confirm_label: null, deny_label: null, risk: 'high', remember_label: null, topic: null, scan_source: null }];
    const a = scriptedAi([[ask], [add], [finish]]);
    const run = await o.newRun();
    const { runner } = runnerOf(fabric, a.ai, seam(true));
    expect(await runner.advance(run.id, o.userId, null)).toBe('waiting_human');
    fabric.answer([...fabric.handoffs.values()][0]!, { value: 'approve' });
    // The model's own approval is not the tool's: add_passkey still asks.
    expect(await runner.advance(run.id, o.userId, null)).toBe('waiting_human');
    expect(a.outputs[1]).toBe('Waiting for the owner to approve adding a Hexactra passkey for example.com.');
    fabric.answer([...fabric.handoffs.values()][1]!, { value: 'deny' });
    expect(await runner.advance(run.id, o.userId, null)).toBe('succeeded');
    expect(passkeyActions(fabric)).toEqual([]);
  });
});

describe("the owner's passkeys (E47.5)", () => {
  it('lists and removes for the owner only, never with a key', async () => {
    const a = await login(`pk-list-a-${stamp}@example.test`);
    const b = await login(`pk-list-b-${stamp}@example.test`);
    const store = app.get(StorePasskeys, { strict: false });
    const { id } = await store.save(a.userId, { rpId: 'example.com', origin: 'https://login.example.com', credentialId: 'Y3JlZA', userHandle: 'dXNlcg', userName: 'person-a', publicKey: 'cHVi', privateKey: Buffer.from('MARKER-list-key') });
    const list = await app.inject({ method: 'GET', url: '/api/secrets/passkeys', headers: { authorization: `Bearer ${a.token}` } });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ data: unknown[] }>().data).toEqual([{ id, site: 'example.com', origin: 'https://login.example.com', account: 'person-a', createdAt: expect.any(String), lastUsedAt: null }]);
    expect(list.body).not.toContain('MARKER');
    const other = await app.inject({ method: 'GET', url: '/api/secrets/passkeys', headers: { authorization: `Bearer ${b.token}` } });
    expect(other.json<{ data: unknown[] }>().data).toEqual([]);
    expect((await app.inject({ method: 'DELETE', url: `/api/secrets/passkeys/${id}`, headers: { authorization: `Bearer ${b.token}` } })).statusCode).toBe(404);
    const removed = await app.inject({ method: 'DELETE', url: `/api/secrets/passkeys/${id}`, headers: { authorization: `Bearer ${a.token}` } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json<{ data: unknown }>().data).toEqual({ removed: true, removeOnSite: true });
    expect(await prisma.passkeyCredential.count({ where: { id } })).toBe(0);
  });
});
