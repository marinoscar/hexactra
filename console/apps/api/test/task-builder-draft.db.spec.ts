// The db tier: a task draft from the builder's spec (E42.2, #719): every field, the schedules, what becomes a
// warning instead of a failure, the fallback without a model, the task link that archives the builder, ownership.
import type { AiService } from '@marinoscar/platform-api/ai';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { ChatTaskDraftService } from '../src/chat/chat-task-draft.service';
import { ChatService } from '../src/chat/chat.service';
import { createApp } from '../src/main';
import { PoliciesService } from '../src/policies/policies.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TaskBuilderDraftService, TASK_BUILDER_DRAFT_INSTRUCTIONS } from '../src/task-builder/task-builder-draft.service';
import { TaskBuilderService } from '../src/task-builder/task-builder.service';
import type { TaskBuilderSpecPatch } from '../src/task-builder/task-builder.spec.schema';

let app: NestFastifyApplication;
let prisma: PrismaService;
let builders: TaskBuilderService;
const stamp = `${Date.now()}`;

const workerMode = process.env.JOBS_WORKER_MODE;
beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
  prisma = app.get(PrismaService);
  builders = app.get(TaskBuilderService, { strict: false });
});
afterAll(async () => {
  await app?.close();
});

type Session = { token: string; userId: string };
async function login(name: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email: `bdraft-${name}-${stamp}@example.test`, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
async function call<T = unknown>(s: Session, method: 'GET' | 'POST', url: string, payload?: unknown): Promise<{ statusCode: number; code?: string; data: T }> {
  const res = await app.inject({ method, url: `/api${url}`, headers: { authorization: `Bearer ${s.token}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const body = res.body ? res.json<{ data?: T; code?: string; error?: { code?: string } }>() : {};
  return { statusCode: res.statusCode, code: body.code ?? body.error?.code, data: body.data as T };
}

/** A model whose `respond` answers the given text (or fails), remembering what it was asked. */
function scriptedAi(answer: string | Error) {
  const asked: { instructions: string; input: string }[] = [];
  const features: unknown[] = [];
  const respond = jest.fn(async (req: { instructions: string; input: string }) => {
    asked.push(req);
    if (answer instanceof Error) throw answer;
    return { outputText: answer };
  });
  const ai = { forUser: (_u: string, opts: unknown) => (features.push(opts), { respond }) } as unknown as AiService;
  return { ai, asked, features };
}

function service(ai: AiService): TaskBuilderDraftService {
  return new TaskBuilderDraftService(prisma, builders, app.get(ChatTaskDraftService, { strict: false }), app.get(ChatService, { strict: false }), ai, app.get(PoliciesService, { strict: false }));
}

async function builderWith(s: Session, spec: TaskBuilderSpecPatch, seed = 'Pay my water bill every month'): Promise<string> {
  const b = await builders.create({ id: s.userId }, { seed });
  await builders.patchSpec(s.userId, b.id, spec);
  return b.id;
}

describe('task builder draft (E42.2)', () => {
  it('drafts every field from the spec, with schedules, accounts, policy and memory defaults', async () => {
    const alice = await login('full');
    const marin = await prisma.connection.create({ data: { userId: alice.userId, provider: 'google', accountId: `acct-m-${stamp}`, accountEmail: 'marin@example.test', label: 'Marin', capabilities: ['mail_read', 'mail_send'], grantedScopes: [], status: 'active' } });
    const wife = await prisma.memory.create({ data: { userId: alice.userId, kind: 'person', label: 'My wife', attributes: { name: 'Person A', email: 'person-a@example.test' }, source: 'owner' } });
    const id = await builderWith(alice, {
      name: 'Water bill',
      objective: 'The bill is paid',
      parameters: [{ name: 'Amount', type: 'money' }, { name: 'Recipient', type: 'email', memory: 'My wife', attribute: 'email' }],
      outputs: [{ label: 'Confirmation number', type: 'text' }],
      allowedDomains: ['water.example.test'],
      accounts: [{ label: 'marin', access: 'read_write' }],
      guardrails: { confirmRiskyActions: true, useSavedLogins: true, useSavedCards: true, unattendedPayments: 'allow' },
      needsBrowser: 'always',
      policy: { ref: 'builtin:balanced' },
      schedules: [{ cron: '0 9 1 * *', timezone: 'America/Costa_Rica', inputs: { Amount: '25' } }],
    });
    const { ai, asked, features } = scriptedAi(JSON.stringify({ name: 'Pay the water bill', goal: 'Pay {{Amount}} on water.example.test and email the receipt to {{Recipient}}. Done when the confirmation number is shown.' }));
    const d = await service(ai).draft(alice.userId, id, null);

    expect(features).toEqual([{ feature: 'task_builder' }]);
    expect(asked[0]!.instructions).toBe(TASK_BUILDER_DRAFT_INSTRUCTIONS);
    expect(asked[0]!.input).toContain('"objective": "The bill is paid"');
    expect(asked[0]!.input).toContain('Pay my water bill every month');
    expect(d).toMatchObject({
      name: 'Pay the water bill',
      goal: expect.stringContaining('{{Amount}}'),
      policyId: 'builtin:balanced',
      allowedDomains: ['water.example.test'],
      confirmRiskyActions: true,
      useSavedLogins: true,
      useSavedCards: true,
      useSavedIdentity: false,
      unattendedPayments: 'allow',
      needsBrowser: 'always',
      connections: [{ connectionId: marin.id, access: 'read_write' }],
      schedules: [{ cron: '0 9 1 * *', timezone: 'America/Costa_Rica', enabled: true, concurrency: 'skip', policyId: null, inputs: { amount: '25' } }],
      warnings: [],
    });
    expect(d.parameters.map((p) => [p.key, p.type])).toEqual([['amount', 'money'], ['recipient', 'email']]);
    expect(d.parameters[1]!.default).toEqual({ memory: { id: wife.id, attribute: 'email' } });
    expect(d.outputs.map((o) => o.label)).toEqual(['Confirmation number']);
    // Nothing was saved or listed.
    expect(await prisma.task.count({ where: { userId: alice.userId } })).toBe(0);
    expect(await prisma.conversationConnection.count({ where: { conversationId: id } })).toBe(0);
  });

  it('turns what does not pass into warnings, never a failure', async () => {
    const bob = await login('warn');
    const id = await builderWith(bob, {
      goal: 'Book a court for {{Day}}',
      parameters: [{ name: 'Day', type: 'date' }, { name: 'Partner', type: 'text' }],
      accounts: [{ label: 'Nobody', access: 'read' }],
      policy: { ref: '00000000-0000-4000-8000-000000000000' },
      schedules: [{ cron: '0 7 * * 6', timezone: 'UTC', inputs: { Day: 'Saturday', Court: '3' } }],
      guardrails: { useSavedLogins: false, useSavedIdentity: true },
    });
    const d = await service(scriptedAi('not json').ai).draft(bob.userId, id, null);
    expect(d.goal).toBe('Book a court for {{Day}}');
    expect(d.parameters.map((p) => p.key)).toEqual(['day']);
    expect(d.connections).toEqual([]);
    expect(d.policyId).toBeNull();
    expect(d.schedules).toEqual([{ cron: '0 7 * * 6', timezone: 'UTC', enabled: true, concurrency: 'skip', policyId: null, inputs: { day: 'Saturday' } }]);
    expect(d.warnings).toEqual([
      'The goal does not use {{Partner}}: add it to the goal or remove the parameter.',
      'No active account is named "Nobody": add it under Accounts, or choose another.',
      'The agent policy "00000000-0000-4000-8000-000000000000" is not one you can use: the task follows your default policy.',
      'A schedule\'s value for "Court" was left out: the task has no such parameter.',
      'Saved details and saved cards need "Sign in with my saved logins": turn it on, or they stay unused.',
    ]);
  });

  it('falls back to the objective, then the first message, when no model answers; refuses an empty builder', async () => {
    const carol = await login('fallback');
    const fromObjective = await builderWith(carol, { objective: 'Check my miles balance' });
    const failing = scriptedAi(new Error('no model'));
    expect((await service(failing.ai).draft(carol.userId, fromObjective, null)).goal).toBe('Check my miles balance');

    const onlySeed = (await builders.create({ id: carol.userId }, { seed: 'Renew my library books' })).id;
    const d = await service(failing.ai).draft(carol.userId, onlySeed, null);
    expect(d.goal).toBe('Renew my library books');
    expect(d.name).toBe('Renew my library books');

    const empty = (await builders.create({ id: carol.userId }, {})).id;
    await expect(service(failing.ai).draft(carol.userId, empty, null)).rejects.toMatchObject({ response: { code: 'TASK_SPEC_INCOMPLETE' } });
  });

  it('serves the draft over the route (no model configured: the spec fallback), links the saved task and archives the builder', async () => {
    const dave = await login('route');
    const id = await builderWith(dave, { name: 'Miles', goal: 'Check my miles balance', schedules: [{ cron: '0 8 * * 1', timezone: 'UTC' }] });
    const r = await call<{ goal: string; schedules: unknown[]; warnings: string[] }>(dave, 'POST', `/task-builder/${id}/draft`);
    expect(r.statusCode).toBe(200);
    expect(r.data.goal).toBe('Check my miles balance');
    expect(r.data.schedules).toHaveLength(1);

    const task = await call<{ id: string }>(dave, 'POST', '/tasks', { name: 'Miles', goal: r.data.goal });
    expect(task.statusCode).toBe(201);
    const link = await call<{ role: string; text: string }>(dave, 'POST', `/task-builder/${id}/task-link`, { taskId: task.data.id });
    expect(link.statusCode).toBe(201);
    expect(link.data).toMatchObject({ role: 'system', text: 'Saved as the task "Miles".' });
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id } })).status).toBe('archived');
    // Linking twice is one line.
    await call(dave, 'POST', `/task-builder/${id}/task-link`, { taskId: task.data.id });
    expect(await prisma.chatMessage.count({ where: { conversationId: id, role: 'system' } })).toBe(1);
  });

  it("is the owner's own", async () => {
    const erin = await login('owner');
    const frank = await login('other');
    const id = await builderWith(erin, { goal: 'Anything' });
    expect((await call(frank, 'POST', `/task-builder/${id}/draft`)).code).toBe('TASK_BUILDER_NOT_FOUND');
    const task = await call<{ id: string }>(frank, 'POST', '/tasks', { name: 'Mine', goal: 'Mine' });
    expect((await call(frank, 'POST', `/task-builder/${id}/task-link`, { taskId: task.data.id })).code).toBe('TASK_BUILDER_NOT_FOUND');
    // The owner cannot link another user's task.
    expect((await call(erin, 'POST', `/task-builder/${id}/task-link`, { taskId: task.data.id })).statusCode).toBe(404);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id } })).status).toBe('active');
  });
});
