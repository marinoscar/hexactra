// Agent policies (#401) against a real, migrated and seeded database: the CRUD
// API and its errors, isolation, model pin validation, the default and its
// resolution, the run snapshot, the legacy task fields and their data migration.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { UsableModelsService, type AiService } from '@marinoscar/platform-api/ai';

import { randomUUID } from 'node:crypto';

import { createApp } from '../src/main';
import { balancedSpec } from '../src/policies/builtin-policies';
import { legacyTaskSpec } from '../src/policies/legacy-task-policy';
import type { AgentPolicySpec } from '../src/policies/agent-policy.schema';
import { PolicyModelCheck } from '../src/policies/policy-model-check';
import { PolicyResolver } from '../src/policies/policy.resolver';
import { PrismaService } from '../src/prisma/prisma.service';
import type { FabricClient } from '../src/fabric/fabric.client';
import { GoalRunnerService } from '../src/runner/goal-runner.service';
import { TasksService } from '../src/tasks/tasks.service';

let app: NestFastifyApplication;
const stamp = `${Date.now()}`;

async function login(email: string, role: 'admin' | 'contributor' | 'viewer' = 'contributor'): Promise<{ token: string; userId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
const as = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const data = <T,>(res: { json: <U>() => U }): T => res.json<{ data: T }>().data;
const errCode = (res: { json: <U>() => U }): string => res.json<{ error?: { code?: string }; code?: string }>().error?.code ?? res.json<{ code?: string }>().code ?? '';

interface Policy {
  id: string;
  name: string;
  version: number;
  builtin: boolean;
  isDefault: boolean;
  hasNoHardStop: boolean;
  usage: { tasks: number; schedules: number };
  spec: AgentPolicySpec;
}

function spec(change: (s: AgentPolicySpec) => void = () => undefined): AgentPolicySpec {
  const s = balancedSpec();
  change(s);
  return s;
}

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
});

async function createPolicy(token: string, name: string, s: AgentPolicySpec = spec()): Promise<Policy> {
  const res = await app.inject({ method: 'POST', url: '/api/agent-policies', headers: as(token), payload: { name, spec: s } });
  expect(res.statusCode).toBe(201);
  return data<Policy>(res);
}

describe('the agent policy API', () => {
  it('lists the four built-ins with Balanced as the default, then creates, reads, edits and deletes an own policy', async () => {
    const alice = await login(`pol-crud-${stamp}@example.test`);
    const list = data<Policy[]>(await app.inject({ method: 'GET', url: '/api/agent-policies', headers: as(alice.token) }));
    expect(list.map((p) => p.id)).toEqual(['builtin:economy', 'builtin:balanced', 'builtin:thorough', 'builtin:unlimited']);
    expect(list.every((p) => p.builtin)).toBe(true);
    expect(list.filter((p) => p.isDefault).map((p) => p.id)).toEqual(['builtin:balanced']);
    expect(list.find((p) => p.id === 'builtin:unlimited')).toMatchObject({ hasNoHardStop: true });
    expect(list.find((p) => p.id === 'builtin:balanced')).toMatchObject({ hasNoHardStop: false, usage: { tasks: 0, schedules: 0 } });

    const made = await createPolicy(alice.token, 'Careful');
    expect(made).toMatchObject({ name: 'Careful', version: 1, builtin: false, isDefault: false });
    const dup = await app.inject({ method: 'POST', url: '/api/agent-policies', headers: as(alice.token), payload: { name: 'Careful', spec: spec() } });
    expect(dup.statusCode).toBe(409);
    expect(errCode(dup)).toBe('POLICY_NAME_TAKEN');

    const read = data<Policy>(await app.inject({ method: 'GET', url: `/api/agent-policies/${made.id}`, headers: as(alice.token) }));
    expect(read.spec).toEqual(made.spec);
    expect(data<Policy>(await app.inject({ method: 'GET', url: '/api/agent-policies/builtin:thorough', headers: as(alice.token) })).builtin).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/agent-policies/builtin:nope', headers: as(alice.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/agent-policies/not-a-ref', headers: as(alice.token) })).statusCode).toBe(404);

    const bad = await app.inject({ method: 'POST', url: '/api/agent-policies', headers: as(alice.token), payload: { name: 'Bad', spec: spec((s) => { s.models.startTier = 'frontier'; s.models.maxTier = 'fast'; }) } });
    expect(bad.statusCode).toBe(400);

    const edited = await app.inject({ method: 'PATCH', url: `/api/agent-policies/${made.id}`, headers: as(alice.token), payload: { name: 'Careful v2', spec: spec((s) => { s.budget.maxActions = 10; }) } });
    expect(data<Policy>(edited)).toMatchObject({ name: 'Careful v2', version: 2 });
    expect(data<Policy>(edited).spec.budget.maxActions).toBe(10);

    expect((await app.inject({ method: 'DELETE', url: `/api/agent-policies/${made.id}`, headers: as(alice.token) })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/agent-policies/${made.id}`, headers: as(alice.token) })).statusCode).toBe(404);
  });

  it('answers 412 to a stale If-Match and bumps the version otherwise', async () => {
    const alice = await login(`pol-match-${stamp}@example.test`);
    const p = await createPolicy(alice.token, 'Matched');
    const ok = await app.inject({ method: 'PATCH', url: `/api/agent-policies/${p.id}`, headers: as(alice.token, { 'if-match': '1' }), payload: { description: 'first' } });
    expect(data<Policy>(ok).version).toBe(2);
    const stale = await app.inject({ method: 'PATCH', url: `/api/agent-policies/${p.id}`, headers: as(alice.token, { 'if-match': '"1"' }), payload: { description: 'second' } });
    expect(stale.statusCode).toBe(412);
    expect(errCode(stale)).toBe('POLICY_VERSION_CONFLICT');
    const fresh = await app.inject({ method: 'PATCH', url: `/api/agent-policies/${p.id}`, headers: as(alice.token, { 'if-match': '2' }), payload: { description: 'second' } });
    expect(data<Policy>(fresh)).toMatchObject({ version: 3 });
  });

  it('makes built-ins immutable (403) but duplicable', async () => {
    const alice = await login(`pol-builtin-${stamp}@example.test`);
    const patch = await app.inject({ method: 'PATCH', url: '/api/agent-policies/builtin:economy', headers: as(alice.token), payload: { name: 'Cheaper' } });
    expect(patch.statusCode).toBe(403);
    expect(errCode(patch)).toBe('POLICY_BUILTIN_READONLY');
    expect((await app.inject({ method: 'DELETE', url: '/api/agent-policies/builtin:economy', headers: as(alice.token) })).statusCode).toBe(403);

    const copy = await app.inject({ method: 'POST', url: '/api/agent-policies/builtin:economy/duplicate', headers: as(alice.token), payload: { name: 'My economy' } });
    expect(copy.statusCode).toBe(201);
    const c = data<Policy>(copy);
    expect(c).toMatchObject({ name: 'My economy', builtin: false, version: 1 });
    expect(c.spec.budget.maxActions).toBe(40);
    const ownCopy = await app.inject({ method: 'POST', url: `/api/agent-policies/${c.id}/duplicate`, headers: as(alice.token), payload: { name: 'My economy 2' } });
    expect(ownCopy.statusCode).toBe(201);
  });

  it('refuses to delete a policy in use unless reassigned, and never the default', async () => {
    const alice = await login(`pol-delete-${stamp}@example.test`);
    const p = await createPolicy(alice.token, 'In use');
    const task = data<{ id: string }>(await app.inject({ method: 'POST', url: '/api/tasks', headers: as(alice.token), payload: { name: 'Uses it', goal: 'g', policyId: p.id } }));
    const sched = data<{ id: string; policyId: string | null }>(
      await app.inject({ method: 'POST', url: '/api/schedules', headers: as(alice.token), payload: { taskId: task.id, cron: '0 9 * * 1-5', policyId: p.id } }),
    );
    expect(sched.policyId).toBe(p.id);

    expect(data<Policy[]>(await app.inject({ method: 'GET', url: '/api/agent-policies', headers: as(alice.token) })).find((x) => x.id === p.id)?.usage).toEqual({ tasks: 1, schedules: 1 });

    const blocked = await app.inject({ method: 'DELETE', url: `/api/agent-policies/${p.id}`, headers: as(alice.token) });
    expect(blocked.statusCode).toBe(409);
    expect(errCode(blocked)).toBe('POLICY_IN_USE');
    const details = blocked.json<{ error?: { details?: { tasks: { id: string }[]; schedules: { id: string }[] } }; details?: { tasks: { id: string }[]; schedules: { id: string }[] } }>();
    const d = details.error?.details ?? details.details;
    expect(d?.tasks.map((t) => t.id)).toEqual([task.id]);
    expect(d?.schedules.map((s) => s.id)).toEqual([sched.id]);

    const bogus = await app.inject({ method: 'DELETE', url: `/api/agent-policies/${p.id}?reassignTo=3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e`, headers: as(alice.token) });
    expect(bogus.statusCode).toBe(400);

    const moved = await app.inject({ method: 'DELETE', url: `/api/agent-policies/${p.id}?reassignTo=builtin:thorough`, headers: as(alice.token) });
    expect(moved.statusCode).toBe(204);
    expect(data<{ policyId: string }>(await app.inject({ method: 'GET', url: `/api/tasks/${task.id}`, headers: as(alice.token) })).policyId).toBe('builtin:thorough');
    const schedules = data<{ policyId: string }[]>(await app.inject({ method: 'GET', url: `/api/schedules?taskId=${task.id}`, headers: as(alice.token) }));
    expect(schedules[0]!.policyId).toBe('builtin:thorough');

    // The default policy cannot be deleted, with or without reassignment.
    const chosen = await createPolicy(alice.token, 'Chosen default');
    const set = await app.inject({ method: 'PUT', url: '/api/agent-policies/default', headers: as(alice.token), payload: { policyId: chosen.id } });
    expect(data(set)).toEqual({ policyId: chosen.id, explicit: true });
    expect(data<Policy>(await app.inject({ method: 'GET', url: `/api/agent-policies/${chosen.id}`, headers: as(alice.token) })).isDefault).toBe(true);
    const def = await app.inject({ method: 'DELETE', url: `/api/agent-policies/${chosen.id}?reassignTo=builtin:economy`, headers: as(alice.token) });
    expect(def.statusCode).toBe(409);
    expect(errCode(def)).toBe('POLICY_IS_DEFAULT');

    // Back to Balanced: now it can go.
    expect(data(await app.inject({ method: 'PUT', url: '/api/agent-policies/default', headers: as(alice.token), payload: { policyId: null } }))).toEqual({ policyId: 'builtin:balanced', explicit: false });
    expect((await app.inject({ method: 'DELETE', url: `/api/agent-policies/${chosen.id}`, headers: as(alice.token) })).statusCode).toBe(204);
  });

  it('keeps one user from seeing, editing or using another\'s policies', async () => {
    const alice = await login(`pol-iso-a-${stamp}@example.test`);
    const bob = await login(`pol-iso-b-${stamp}@example.test`);
    const p = await createPolicy(alice.token, 'Private');

    expect(data<Policy[]>(await app.inject({ method: 'GET', url: '/api/agent-policies', headers: as(bob.token) })).map((x) => x.id)).not.toContain(p.id);
    expect((await app.inject({ method: 'GET', url: `/api/agent-policies/${p.id}`, headers: as(bob.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/api/agent-policies/${p.id}`, headers: as(bob.token), payload: { name: 'Mine now' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/agent-policies/${p.id}`, headers: as(bob.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/agent-policies/${p.id}/duplicate`, headers: as(bob.token), payload: { name: 'Copy' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: '/api/agent-policies/default', headers: as(bob.token), payload: { policyId: p.id } })).statusCode).toBe(404);
    const task = await app.inject({ method: 'POST', url: '/api/tasks', headers: as(bob.token), payload: { name: 't', goal: 'g', policyId: p.id } });
    expect(task.statusCode).toBe(400);
    expect(errCode(task)).toBe('POLICY_REF_INVALID');
    const run = await app.inject({ method: 'POST', url: '/api/runs', headers: as(bob.token), payload: { goal: 'g', policyId: p.id } });
    expect(run.statusCode).toBe(400);
  });

  it('enforces the permissions: a viewer reads, a contributor writes, nobody anonymous', async () => {
    const viewer = await login(`pol-viewer-${stamp}@example.test`, 'viewer');
    expect((await app.inject({ method: 'GET', url: '/api/agent-policies', headers: as(viewer.token) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/agent-policies', headers: as(viewer.token), payload: { name: 'x', spec: spec() } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/agent-policies/default', headers: as(viewer.token), payload: { policyId: null } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/agent-policies' })).statusCode).toBe(401);
  });
});

describe('model pins', () => {
  const usable = (list: { provider: string; modelId: string; capabilities: string[] }[]) =>
    jest.spyOn(app.get(UsableModelsService, { strict: false }), 'listForUser').mockResolvedValue(
      list.map((m) => ({ provider: m.provider, modelId: m.modelId, displayName: null, capabilities: { capabilities: m.capabilities, inputModalities: ['text'], outputModalities: ['text'] }, keySource: 'org' })) as never,
    );
  afterEach(() => jest.restoreAllMocks());
  const withPin = (pin: string) => spec((s) => { s.models.pins = { standard: pin }; });

  it('refuses a pin to an unknown or disabled model with 400 POLICY_PIN_INVALID', async () => {
    const alice = await login(`pol-pin-${stamp}@example.test`);
    // The real catalogue of this database: AI is not set up, no model is usable.
    const unknown = await app.inject({ method: 'POST', url: '/api/agent-policies', headers: as(alice.token), payload: { name: 'Pinned', spec: withPin('disabled-model') } });
    expect(unknown.statusCode).toBe(400);
    expect(errCode(unknown)).toBe('POLICY_PIN_INVALID');

    usable([{ provider: 'prov-a', modelId: 'model-1', capabilities: ['tools', 'vision_input'] }]);
    const still = await app.inject({ method: 'POST', url: '/api/agent-policies', headers: as(alice.token), payload: { name: 'Pinned', spec: withPin('disabled-model') } });
    expect(still.statusCode).toBe(400);
  });

  it('refuses a model without tools and vision, and accepts an enabled one on create and edit', async () => {
    const alice = await login(`pol-pin2-${stamp}@example.test`);
    usable([
      { provider: 'prov-a', modelId: 'model-1', capabilities: ['tools', 'vision_input'] },
      { provider: 'prov-a', modelId: 'text-only', capabilities: ['tools'] },
    ]);
    const noVision = await app.inject({ method: 'POST', url: '/api/agent-policies', headers: as(alice.token), payload: { name: 'Blind', spec: withPin('text-only') } });
    expect(noVision.statusCode).toBe(400);
    expect(errCode(noVision)).toBe('POLICY_PIN_INVALID');

    const ok = await app.inject({ method: 'POST', url: '/api/agent-policies', headers: as(alice.token), payload: { name: 'Sighted', spec: withPin('prov-a:model-1') } });
    expect(ok.statusCode).toBe(201);
    expect(data<Policy>(ok).spec.models.pins).toEqual({ standard: 'prov-a:model-1' });

    const edit = await app.inject({ method: 'PATCH', url: `/api/agent-policies/${data<Policy>(ok).id}`, headers: as(alice.token), payload: { spec: withPin('text-only') } });
    expect(edit.statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `/api/agent-policies/${data<Policy>(ok).id}`, headers: as(alice.token), payload: { spec: withPin('model-1') } })).statusCode).toBe(200);
  });
});

/** An in-memory fabric: a session and its actions. */
function fakeFabric() {
  const handoffs = new Map<string, { id: string; status: string; input: string; kind: string; response?: Record<string, unknown> }>();
  const request = jest.fn(async (method: string, path: string, opts: { body?: Record<string, unknown> } = {}) => {
    if (method === 'POST' && path === '/v1/sessions') return { id: '00000000-0000-4000-8000-00000000000a' };
    if (method === 'DELETE' && path.startsWith('/v1/sessions/')) return undefined;
    if (method === 'POST' && path.endsWith('/actions')) {
      const action = opts.body!.action as Record<string, unknown>;
      return { id: 'op', state: 'succeeded', result: action.type === 'navigate' ? { url: action.url, title: 'Page' } : {} };
    }
    if (method === 'POST' && path.endsWith('/handoffs')) {
      const id = randomUUID();
      handoffs.set(id, { id, status: 'pending', input: String(opts.body!.input), kind: String(opts.body!.kind) });
      return { handoff: { id } };
    }
    if (method === 'GET' && path.startsWith('/v1/handoffs/')) return handoffs.get(path.split('/')[3]!);
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { client: { request, config: async () => ({ url: 'http://f', token: 't' }) } as unknown as FabricClient, handoffs };
}

type Call = [name: string, args: Record<string, unknown>];
function scriptedAi(scripts: Call[][]) {
  const runTools = jest.fn(async (req: { tools: { tool: { name: string }; execute: (a: unknown, c: unknown) => Promise<unknown> }[]; onStep?: (s: unknown) => void }) => {
    const script = scripts.shift() ?? [];
    let step = 0;
    for (const [name, args] of script) {
      const t = req.tools.find((x) => x.tool.name === name)!;
      await t.execute(args, { userId: 'u' });
      req.onStep?.({ step: ++step, response: { usage: { inputTokens: 10, outputTokens: 5 } }, calls: [] });
    }
    return { final: { outputText: '' }, steps: [], stopReason: 'steps_exhausted' };
  });
  return { ai: { forUser: () => ({ runTools }) } as unknown as AiService, runTools };
}

function runnerFor(ai: AiService, fabric: FabricClient) {
  return new GoalRunnerService(app.get(PrismaService), app.get(TasksService), fabric, ai, undefined, undefined, undefined, app.get(PolicyResolver), app.get(PolicyModelCheck));
}

describe('the run snapshot and the runner', () => {
  it('snapshots the resolved policy at the first advance and never changes it, whatever is edited later', async () => {
    const alice = await login(`pol-snap-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const db = prisma.forUser({ userId: alice.userId });
    const p = await createPolicy(alice.token, 'Snapshotted');
    const task = await db.task.create({ data: { userId: alice.userId, name: 'T', goal: 'g', policyRef: p.id } });
    const run = await db.run.create({ data: { userId: alice.userId, taskId: task.id, goal: 'g' } });

    // The run response carries no policy until its first advance.
    expect(data<{ policy: unknown }>(await app.inject({ method: 'GET', url: `/api/runs/${run.id}`, headers: as(alice.token) })).policy).toBeNull();

    const fabric = fakeFabric();
    const { ai } = scriptedAi([[['request_human', { kind: 'confirmation', prompt: 'ok?', input: 'none', choices: null }]], [['finish', { success: true, result: 'done' }]]]);
    const runner = runnerFor(ai, fabric.client);
    expect(await runner.advance(run.id, alice.userId, null)).toBe('waiting_human');

    const after = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(after).toMatchObject({ policyRef: p.id, policyVersion: 1, policySource: 'task' });
    const snap = after.policySnapshot as { ref: string; name: string; version: number; source: string; spec: AgentPolicySpec };
    expect(snap).toMatchObject({ ref: p.id, name: 'Snapshotted', version: 1, source: 'task' });
    expect(snap.spec.budget.maxActions).toBe(60);

    // Edit the policy, move the task, change the user's default: the run keeps its snapshot.
    await app.inject({ method: 'PATCH', url: `/api/agent-policies/${p.id}`, headers: as(alice.token), payload: { spec: spec((s) => { s.budget.maxActions = 7; }) } });
    await db.task.updateMany({ where: { id: task.id }, data: { policyRef: 'builtin:economy' } });
    await app.inject({ method: 'PUT', url: '/api/agent-policies/default', headers: as(alice.token), payload: { policyId: 'builtin:thorough' } });
    // The person answers; the run resumes (a second advance) and finishes.
    Object.assign([...fabric.handoffs.values()][0]!, { status: 'completed', response: { outcome: 'completed', value: 'approve', value_withheld: false } });
    expect(await runner.advance(run.id, alice.userId, null)).toBe('succeeded');
    const later = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(later.policySnapshot).toEqual(after.policySnapshot);
    expect(later.policyVersion).toBe(1);

    const view = data<{ policy: { id: string; name: string; version: number; source: string; builtin: boolean } }>(await app.inject({ method: 'GET', url: `/api/runs/${run.id}`, headers: as(alice.token) }));
    expect(view.policy).toEqual({ id: p.id, name: 'Snapshotted', version: 1, source: 'task', builtin: false });
    expect(JSON.stringify(view)).not.toContain('policySnapshot');
  });

  it('maps maxActions and maxActiveMinutes onto the runner limits, with null meaning no limit', async () => {
    const alice = await login(`pol-limits-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const db = prisma.forUser({ userId: alice.userId });
    const fabric = fakeFabric();

    // One action allowed: the second is refused and the run ends on the step budget.
    const tight = await createPolicy(alice.token, 'One action', spec((s) => { s.budget.maxActions = 1; }));
    const r1 = await db.run.create({ data: { userId: alice.userId, goal: 'g', policyRef: tight.id, policySource: 'run' } });
    const s1 = scriptedAi([[['navigate', { url: 'https://shop.example.test/', reason: 'a' }], ['navigate', { url: 'https://shop.example.test/b', reason: 'b' }]]]);
    expect(await runnerFor(s1.ai, fabric.client).advance(r1.id, alice.userId, null)).toBe('failed');
    expect(await db.run.findFirstOrThrow({ where: { id: r1.id } })).toMatchObject({ error: 'Step budget exhausted', stepCount: 1, policySource: 'run' });

    // The time limit: a run that already worked two active minutes under a one-minute budget (active time, #399).
    const short = await createPolicy(alice.token, 'One minute', spec((s) => { s.budget.maxActiveMinutes = 1; }));
    const r2 = await db.run.create({ data: { userId: alice.userId, goal: 'g', policyRef: short.id, policySource: 'run', activeMs: 2 * 60_000 } });
    const s2 = scriptedAi([[['navigate', { url: 'https://shop.example.test/', reason: 'a' }]]]);
    expect(await runnerFor(s2.ai, fabric.client).advance(r2.id, alice.userId, null)).toBe('failed');
    expect((await db.run.findFirstOrThrow({ where: { id: r2.id } })).error).toBe('Time budget exhausted');

    // Unlimited: more actions than any built-in allows, and 48 h of active time already spent, still finish.
    const r3 = await db.run.create({ data: { userId: alice.userId, goal: 'g', policyRef: 'builtin:unlimited', policySource: 'run', activeMs: 48 * 3_600_000 } });
    const many: Call[] = Array.from({ length: 70 }, (_, i): Call => ['navigate', { url: `https://shop.example.test/${i}`, reason: 'x' }]);
    const s3 = scriptedAi([many.slice(0, 15), many.slice(15, 30), many.slice(30, 45), many.slice(45, 60), [...many.slice(60), ['finish', { success: true, result: 'ok' }]]]);
    expect(await runnerFor(s3.ai, fabric.client).advance(r3.id, alice.userId, null)).toBe('succeeded');
    expect(await db.run.findFirstOrThrow({ where: { id: r3.id } })).toMatchObject({ stepCount: 71, policySource: 'run', policyRef: 'builtin:unlimited' });
  });

  it('notes a fall-through in the run log and runs under the next level', async () => {
    const alice = await login(`pol-fall-${stamp}@example.test`);
    const db = app.get(PrismaService).forUser({ userId: alice.userId });
    const task = await db.task.create({ data: { userId: alice.userId, name: 'T', goal: 'g', policyRef: '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e' } });
    const run = await db.run.create({ data: { userId: alice.userId, taskId: task.id, goal: 'g' } });
    const { ai } = scriptedAi([[['finish', { success: true, result: 'ok' }]]]);
    expect(await runnerFor(ai, fakeFabric().client).advance(run.id, alice.userId, null)).toBe('succeeded');
    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({ policyRef: 'builtin:balanced', policySource: 'system_default' });
    expect(JSON.stringify(done.transcript)).toContain('no longer exists or is not yours');
  });
});

describe('the legacy task fields', () => {
  it('maps maxSteps, maxMinutes and model on create and patch to a derived policy, with a Deprecation header', async () => {
    const alice = await login(`pol-legacy-api-${stamp}@example.test`);
    const plain = await app.inject({ method: 'POST', url: '/api/tasks', headers: as(alice.token), payload: { name: 'Plain', goal: 'g' } });
    expect(plain.headers.deprecation).toBeUndefined();
    expect(data<{ policyId: string | null }>(plain).policyId).toBeNull();

    const legacy = await app.inject({ method: 'POST', url: '/api/tasks', headers: as(alice.token), payload: { name: 'Legacy', goal: 'g', maxSteps: 250, maxMinutes: 45, model: 'model-x' } });
    expect(legacy.statusCode).toBe(201);
    expect(legacy.headers.deprecation).toBe('true');
    const t = data<{ id: string; policyId: string; maxSteps: number; model: string }>(legacy);
    expect(t).toMatchObject({ maxSteps: 250, model: 'model-x' });
    const policy = data<Policy>(await app.inject({ method: 'GET', url: `/api/agent-policies/${t.policyId}`, headers: as(alice.token) }));
    expect(policy.name).toBe('Task: Legacy');
    expect(policy.spec.budget).toMatchObject({ maxActions: 250, maxActiveMinutes: 45 });
    expect(policy.spec.models).toMatchObject({ maxTier: 'standard', pins: { standard: 'model-x' } });

    // A second task with the same limits reuses the policy.
    const twin = data<{ policyId: string }>(await app.inject({ method: 'POST', url: '/api/tasks', headers: as(alice.token), payload: { name: 'Twin', goal: 'g', maxSteps: 250, maxMinutes: 45, model: 'model-x' } }));
    expect(twin.policyId).toBe(t.policyId);

    const patched = await app.inject({ method: 'PATCH', url: `/api/tasks/${t.id}`, headers: as(alice.token), payload: { maxSteps: 80 } });
    expect(patched.headers.deprecation).toBe('true');
    const p2 = data<{ policyId: string }>(patched).policyId;
    expect(p2).not.toBe(t.policyId);
    expect(data<Policy>(await app.inject({ method: 'GET', url: `/api/agent-policies/${p2}`, headers: as(alice.token) })).spec.budget).toMatchObject({ maxActions: 80, maxActiveMinutes: 45 });

    // An explicit policyId wins over the legacy fields.
    const explicit = data<{ policyId: string }>(await app.inject({ method: 'PATCH', url: `/api/tasks/${t.id}`, headers: as(alice.token), payload: { maxSteps: 90, policyId: 'builtin:thorough' } }));
    expect(explicit.policyId).toBe('builtin:thorough');
    // Back to the defaults with no model: the task follows the user's default again.
    const reset = data<{ policyId: string | null }>(await app.inject({ method: 'PATCH', url: `/api/tasks/${t.id}`, headers: as(alice.token), payload: { maxSteps: 100, maxMinutes: 30, model: null, policyId: undefined } }));
    expect(reset.policyId).toBeNull();
  });

  it('converts a legacy task with maxSteps 250 and a model in the data migration, and its runs use the policy', async () => {
    const alice = await login(`pol-migrate-${stamp}@example.test`);
    const prisma = app.get(PrismaService);
    const db = prisma.forUser({ userId: alice.userId });
    const legacy = await db.task.create({ data: { userId: alice.userId, name: 'Old task', goal: 'g', maxSteps: 250, maxMinutes: 45, model: 'model-x' } });
    const twin = await db.task.create({ data: { userId: alice.userId, name: 'Old twin', goal: 'g', maxSteps: 250, maxMinutes: 45, model: 'model-x' } });
    const other = await db.task.create({ data: { userId: alice.userId, name: 'Old task', goal: 'g', maxSteps: 30, maxMinutes: 100 } });
    const untouched = await db.task.create({ data: { userId: alice.userId, name: 'Defaults', goal: 'g', maxSteps: 100, maxMinutes: 30 } });
    const already = await db.task.create({ data: { userId: alice.userId, name: 'Has policy', goal: 'g', maxSteps: 7, policyRef: 'builtin:economy' } });

    const sqlFile = join(__dirname, '..', 'prisma', 'migrations');
    const dir = require('node:fs').readdirSync(sqlFile).find((d: string) => d.endsWith('_agent_policies')) as string;
    const migration = readFileSync(join(sqlFile, dir, 'migration.sql'), 'utf8');
    const section = migration.split('-- BEGIN agent_policies_legacy_task_fields')[1]!.split('-- END agent_policies_legacy_task_fields')[0]!;
    const statements = section
      .split(/;\s*\n/)
      .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean);
    const migrate = () =>
      prisma.$transaction(async (tx) => {
        for (const s of statements) await tx.$executeRawUnsafe(s);
      });

    await migrate();
    const policies = () => prisma.agentPolicy.findMany({ where: { userId: alice.userId }, orderBy: { name: 'asc' } });
    const first = await policies();
    expect(first.map((p) => p.name).sort()).toEqual(['Task: Old task', 'Task: Old task (' + first.find((p) => p.name.startsWith('Task: Old task ('))!.name.slice(-7, -1) + ')'].sort());

    const l = await prisma.task.findFirstOrThrow({ where: { id: legacy.id } });
    const tw = await prisma.task.findFirstOrThrow({ where: { id: twin.id } });
    expect(l.policyRef).not.toBeNull();
    expect(tw.policyRef).toBe(l.policyRef);
    expect((await prisma.task.findFirstOrThrow({ where: { id: other.id } })).policyRef).not.toBe(l.policyRef);
    expect((await prisma.task.findFirstOrThrow({ where: { id: untouched.id } })).policyRef).toBeNull();
    expect((await prisma.task.findFirstOrThrow({ where: { id: already.id } })).policyRef).toBe('builtin:economy');

    const derived = data<Policy>(await app.inject({ method: 'GET', url: `/api/agent-policies/${l.policyRef}`, headers: as(alice.token) }));
    expect(derived.spec.models).toMatchObject({ startTier: 'standard', maxTier: 'standard', pins: { standard: 'model-x' } });
    expect(derived.spec.budget).toMatchObject({ maxActions: 250, maxActiveMinutes: 45, maxModelCalls: 120, maxCostUsd: 2 });
    // The SQL builds the same document the service derives.
    expect(derived.spec).toEqual(legacyTaskSpec({ maxSteps: 250, maxMinutes: 45, model: 'model-x' }));

    // Idempotent: a second run changes nothing.
    await migrate();
    expect((await policies()).map((p) => p.id).sort()).toEqual(first.map((p) => p.id).sort());

    // The task's runs use the policy: its snapshot, its limit and its model.
    const run = await db.run.create({ data: { userId: alice.userId, taskId: legacy.id, goal: 'g' } });
    const { ai, runTools } = scriptedAi([[['finish', { success: true, result: 'ok' }]]]);
    expect(await runnerFor(ai, fakeFabric().client).advance(run.id, alice.userId, null)).toBe('succeeded');
    const done = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({ policyRef: l.policyRef, policySource: 'task' });
    expect((done.policySnapshot as { spec: AgentPolicySpec }).spec.budget.maxActions).toBe(250);
    expect(runTools.mock.calls[0]![0]).toMatchObject({ model: 'model-x' });
  });

  it('is safe on an empty database: it converts nothing and fails nothing', async () => {
    const prisma = app.get(PrismaService);
    const dir = (require('node:fs').readdirSync(join(__dirname, '..', 'prisma', 'migrations')) as string[]).find((d) => d.endsWith('_agent_policies'))!;
    const section = readFileSync(join(__dirname, '..', 'prisma', 'migrations', dir, 'migration.sql'), 'utf8').split('-- BEGIN agent_policies_legacy_task_fields')[1]!.split('-- END agent_policies_legacy_task_fields')[0]!;
    const statements = section.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('DELETE FROM tasks WHERE false');
        for (const s of statements) await tx.$executeRawUnsafe(s);
      }),
    ).resolves.toBeUndefined();
  });
});

describe('schedules and run overrides', () => {
  it('stores the schedule policy and the run override on the run, and the user default resolves last', async () => {
    const alice = await login(`pol-levels-${stamp}@example.test`);
    const task = data<{ id: string }>(await app.inject({ method: 'POST', url: '/api/tasks', headers: as(alice.token), payload: { name: 'Levels', goal: 'g', policyId: 'builtin:economy' } }));
    // POST /tasks/:id/runs takes an optional body; without one the task's policy applies.
    const none = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/runs`, headers: as(alice.token) });
    expect(none.statusCode).toBe(201);
    const withOverride = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/runs`, headers: as(alice.token), payload: { policyId: 'builtin:thorough' } });
    expect(withOverride.statusCode).toBe(201);
    const db = app.get(PrismaService).forUser({ userId: alice.userId });
    const row = await db.run.findFirstOrThrow({ where: { id: data<{ id: string }>(withOverride).id } });
    expect(row).toMatchObject({ policyRef: 'builtin:thorough', policySource: 'run' });
    expect(data<{ policy: unknown }>(withOverride).policy).toBeNull();
    expect((await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/runs`, headers: as(alice.token), payload: { policyId: 'bogus' } })).statusCode).toBe(400);

    const adhoc = await app.inject({ method: 'POST', url: '/api/runs', headers: as(alice.token), payload: { goal: 'g', policyId: 'builtin:unlimited' } });
    expect(adhoc.statusCode).toBe(201);

    // Resolution, level by level.
    const resolver = app.get(PolicyResolver);
    expect((await resolver.forRun({ userId: alice.userId, taskId: task.id })).source).toBe('task');
    expect((await resolver.forRun({ userId: alice.userId, taskId: task.id, policyRef: 'builtin:thorough', policySource: 'schedule' })).policy.id).toBe('builtin:thorough');
    await app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, headers: as(alice.token), payload: { policyId: null } });
    expect((await resolver.forRun({ userId: alice.userId, taskId: task.id })).source).toBe('system_default');
    await app.inject({ method: 'PUT', url: '/api/agent-policies/default', headers: as(alice.token), payload: { policyId: 'builtin:thorough' } });
    expect(await resolver.forRun({ userId: alice.userId, taskId: task.id })).toMatchObject({ source: 'user_default', policy: { id: 'builtin:thorough' } });
  });

  it('puts the default policy in the user settings document under browserAgent', async () => {
    const alice = await login(`pol-settings-${stamp}@example.test`);
    await app.inject({ method: 'PUT', url: '/api/agent-policies/default', headers: as(alice.token), payload: { policyId: 'builtin:economy' } });
    const settings = data<{ browserAgent?: { defaultPolicyRef: string } }>(await app.inject({ method: 'GET', url: '/api/user-settings', headers: as(alice.token) }));
    expect(settings.browserAgent).toEqual({ defaultPolicyRef: 'builtin:economy' });
    expect(data(await app.inject({ method: 'GET', url: '/api/agent-policies/default', headers: as(alice.token) }))).toEqual({ policyId: 'builtin:economy', explicit: true });
  });
});
