// Model tiers (#403) against a real, migrated and seeded database: the two
// settings namespaces, the effective-tiers API, the snapshot of the resolved
// tiers at the start of a run, the per-call model, effort and output cap, and a
// model without image input starting the run without screenshots.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { UsableModelsService, type AiService } from '@marinoscar/platform-api/ai';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { createApp } from '../src/main';
import { PolicyModelCheck, PolicyResolver } from '../src/policies';
import { ModelTiersService } from '../src/policies/model-tiers.service';
import type { ResolvedTiers } from '../src/policies/model-tiers.schema';
import { PrismaService } from '../src/prisma/prisma.service';
import type { FabricClient } from '../src/fabric/fabric.client';
import { GoalRunnerService } from '../src/runner/goal-runner.service';
import { TasksService } from '../src/tasks/tasks.service';

let app: NestFastifyApplication;
const stamp = `${Date.now()}`;

const as = (token: string) => ({ authorization: `Bearer ${token}` });
const data = <T,>(res: { json: <U>() => U }): T => res.json<{ data: T }>().data;

async function login(email: string, role: 'admin' | 'contributor' | 'viewer' = 'contributor'): Promise<{ token: string; userId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(token) });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
});
afterEach(() => jest.restoreAllMocks());

/** The models the catalogue says the user can call. */
const CATALOGUE = [
  { provider: 'prov-a', modelId: 'model-vision', capabilities: ['tools', 'vision_input', 'reasoning'] },
  { provider: 'prov-a', modelId: 'model-big', capabilities: ['tools', 'vision_input', 'reasoning'] },
  { provider: 'prov-a', modelId: 'model-text', capabilities: ['tools'] },
  { provider: 'prov-a', modelId: 'model-notools', capabilities: ['vision_input'] },
];
function usable(list = CATALOGUE) {
  return jest.spyOn(app.get(UsableModelsService, { strict: false }), 'listForUser').mockResolvedValue(
    list.map((m) => ({ provider: m.provider, modelId: m.modelId, displayName: null, capabilities: { capabilities: m.capabilities, inputModalities: ['text'], outputModalities: ['text'] }, keySource: 'org' })) as never,
  );
}

async function setDeployment(adminToken: string, body: Record<string, unknown>) {
  const res = await app.inject({ method: 'PATCH', url: '/api/system-settings', headers: as(adminToken), payload: { browserAgentTiers: body } });
  expect(res.statusCode).toBe(200);
}
async function setUser(token: string, tiers: Record<string, unknown> | null) {
  const res = await app.inject({ method: 'PATCH', url: '/api/user-settings', headers: as(token), payload: { browserAgent: { tiers } } });
  expect(res.statusCode).toBe(200);
}
const clearDeployment = async (adminToken: string) =>
  setDeployment(adminToken, { fast: { model: null, reasoningEffort: null, maxOutputTokens: null, fallbackModel: null }, standard: { model: null, reasoningEffort: null, maxOutputTokens: null, fallbackModel: null }, frontier: { model: null, reasoningEffort: null, maxOutputTokens: null, fallbackModel: null } });

interface Effective {
  policy: { id: string; startTier: string; maxTier: string };
  tiers: ResolvedTiers;
}

describe('the model tiers settings and the effective-tiers API', () => {
  it('stores the deployment default through the platform settings route, admin only, and validates it', async () => {
    const admin = await login(`tiers-admin-${stamp}@example.test`, 'admin');
    const user = await login(`tiers-user-${stamp}@example.test`);
    const denied = await app.inject({ method: 'PATCH', url: '/api/system-settings', headers: as(user.token), payload: { browserAgentTiers: { standard: { model: 'prov-a:model-vision' } } } });
    expect(denied.statusCode).toBe(403);
    const bad = await app.inject({ method: 'PATCH', url: '/api/system-settings', headers: as(admin.token), payload: { browserAgentTiers: { standard: { maxOutputTokens: 10 } } } });
    expect(bad.statusCode).toBe(400);

    await setDeployment(admin.token, { standard: { model: 'prov-a:model-vision', reasoningEffort: 'low' } });
    await setDeployment(admin.token, { frontier: { reasoningEffort: 'high' } });
    const read = await app.inject({ method: 'GET', url: '/api/system-settings', headers: as(admin.token) });
    expect(data<{ browserAgentTiers: ResolvedTiers }>(read).browserAgentTiers).toMatchObject({
      standard: { model: 'prov-a:model-vision', reasoningEffort: 'low' },
      frontier: { model: null, reasoningEffort: 'high' },
    });
    await clearDeployment(admin.token);
  });

  it('answers the effective tiers with the source of each value, before :id, for a viewer too', async () => {
    const admin = await login(`tiers-eff-admin-${stamp}@example.test`, 'admin');
    const alice = await login(`tiers-eff-${stamp}@example.test`);
    usable();
    await setDeployment(admin.token, { standard: { model: 'prov-a:model-vision', reasoningEffort: 'low', maxOutputTokens: 2000 }, frontier: { model: 'prov-a:model-big' } });
    await setUser(alice.token, { frontier: { reasoningEffort: 'high' }, fast: { model: 'model-text' } });

    const res = await app.inject({ method: 'GET', url: '/api/agent-policies/model-tiers/effective', headers: as(alice.token) });
    expect(res.statusCode).toBe(200);
    const eff = data<Effective>(res);
    expect(eff.policy).toMatchObject({ id: 'builtin:balanced', startTier: 'standard', maxTier: 'frontier' });
    expect(eff.tiers.fast).toMatchObject({ model: 'prov-a:model-text', modelSource: 'user', vision: false, tools: true, usable: true });
    expect(eff.tiers.standard).toMatchObject({ model: 'prov-a:model-vision', modelSource: 'deployment', reasoningEffort: 'low', effortSource: 'deployment', maxOutputTokens: 2000, vision: true });
    expect(eff.tiers.frontier).toMatchObject({ model: 'prov-a:model-big', modelSource: 'deployment', reasoningEffort: 'high', effortSource: 'user' });

    // A policy pin wins for its tier; ?policyId resolves for another policy.
    const pinned = data<{ id: string }>(
      await app.inject({
        method: 'POST',
        url: '/api/agent-policies',
        headers: as(alice.token),
        payload: { name: 'Pinned tiers', spec: { ...(data<{ spec: unknown }>(await app.inject({ method: 'GET', url: '/api/agent-policies/builtin:balanced', headers: as(alice.token) })).spec as object), models: { startTier: 'standard', maxTier: 'frontier', allowProviderFallback: true, pins: { standard: 'prov-a:model-big' } } } },
      }),
    );
    const viaPin = data<Effective>(await app.inject({ method: 'GET', url: `/api/agent-policies/model-tiers/effective?policyId=${pinned.id}`, headers: as(alice.token) }));
    expect(viaPin.tiers.standard).toMatchObject({ model: 'prov-a:model-big', modelSource: 'pin' });

    const viewer = await login(`tiers-eff-viewer-${stamp}@example.test`, 'viewer');
    expect((await app.inject({ method: 'GET', url: '/api/agent-policies/model-tiers/effective', headers: as(viewer.token) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/agent-policies/model-tiers/effective' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/agent-policies/model-tiers/effective?policyId=nope', headers: as(alice.token) })).statusCode).toBe(400);
    await clearDeployment(admin.token);
  });

  it('reports a tier with no model, naming the Model tiers page, when nothing is set anywhere', async () => {
    const alice = await login(`tiers-none-${stamp}@example.test`);
    usable();
    const eff = data<Effective>(await app.inject({ method: 'GET', url: '/api/agent-policies/model-tiers/effective', headers: as(alice.token) }));
    expect(eff.tiers.standard).toMatchObject({ model: null, usable: false });
    expect(eff.tiers.standard.problem).toMatch(/No model selected.*Model tiers/);
  });

  it('keeps the tiers when the default policy is chosen or reset, and the default when tiers change', async () => {
    const alice = await login(`tiers-keep-${stamp}@example.test`);
    await setUser(alice.token, { standard: { model: 'prov-a:model-vision' } });
    await app.inject({ method: 'PUT', url: '/api/agent-policies/default', headers: as(alice.token), payload: { policyId: 'builtin:thorough' } });
    await app.inject({ method: 'PUT', url: '/api/agent-policies/default', headers: as(alice.token), payload: { policyId: null } });
    const settings = data<{ browserAgent?: { tiers?: unknown } }>(await app.inject({ method: 'GET', url: '/api/user-settings', headers: as(alice.token) }));
    expect(settings.browserAgent?.tiers).toEqual({ standard: { model: 'prov-a:model-vision' } });
    await app.inject({ method: 'PUT', url: '/api/agent-policies/default', headers: as(alice.token), payload: { policyId: 'builtin:economy' } });
    await setUser(alice.token, { standard: { model: null } });
    expect(data(await app.inject({ method: 'GET', url: '/api/agent-policies/default', headers: as(alice.token) }))).toEqual({ policyId: 'builtin:economy', explicit: true });
  });
});

// ---- The runner ----

function fakeFabric() {
  const handoffs = new Map<string, { id: string; status: string; input: string; kind: string; response?: Record<string, unknown> }>();
  const actionTypes: string[] = [];
  let sessions = 0;
  const request = jest.fn(async (method: string, path: string, opts: { body?: Record<string, unknown> } = {}) => {
    if (method === 'POST' && path === '/v1/sessions') {
      sessions += 1;
      return { id: '00000000-0000-4000-8000-00000000000a' };
    }
    if (method === 'DELETE' && path.startsWith('/v1/sessions/')) return undefined;
    if (method === 'POST' && path.endsWith('/actions')) {
      const action = opts.body!.action as Record<string, unknown>;
      actionTypes.push(String(action.type));
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
  return { client: { request, config: async () => ({ url: 'http://f', token: 't' }) } as unknown as FabricClient, handoffs, actionTypes, sessions: () => sessions };
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
  return new GoalRunnerService(
    app.get(PrismaService),
    app.get(TasksService),
    fabric,
    ai,
    undefined,
    undefined,
    app.get(SystemSettingsService),
    app.get(PolicyResolver),
    app.get(PolicyModelCheck),
    app.get(ModelTiersService),
  );
}



describe('the runner and the model tiers', () => {
  it('snapshots the resolved tiers once and sends the tier model, effort and output cap on every call', async () => {
    const alice = await login(`tiers-run-${stamp}@example.test`);
    usable();
    await setUser(alice.token, { standard: { model: 'prov-a:model-vision', reasoningEffort: 'low', maxOutputTokens: 1200 }, frontier: { model: 'prov-a:model-big', reasoningEffort: 'high' } });
    const db = app.get(PrismaService).forUser({ userId: alice.userId });
    const run = await db.run.create({ data: { userId: alice.userId, goal: 'g' } });
    const fabric = fakeFabric();
    const { ai, runTools } = scriptedAi([[['request_human', { kind: 'confirmation', prompt: 'ok?', input: 'none', choices: null }]], [['finish', { success: true, result: 'done' }]]]);
    const runner = runnerFor(ai, fabric.client);
    expect(await runner.advance(run.id, alice.userId, null)).toBe('waiting_human');

    const first = (await db.run.findFirstOrThrow({ where: { id: run.id } })).policySnapshot as { resolvedTiers: ResolvedTiers; tiers: Record<string, { provider: string; model: string }> };
    expect(first.resolvedTiers.standard).toMatchObject({ model: 'prov-a:model-vision', provider: 'prov-a', modelId: 'model-vision', reasoningEffort: 'low', maxOutputTokens: 1200, modelSource: 'user', usable: true, vision: true });
    expect(first.resolvedTiers.frontier).toMatchObject({ model: 'prov-a:model-big', reasoningEffort: 'high' });
    expect(first.resolvedTiers.fast).toMatchObject({ modelSource: 'fill_down', borrowedFrom: 'standard' });
    expect(first.tiers.standard).toEqual({ provider: 'prov-a', model: 'model-vision' });
    expect(runTools.mock.calls[0]![0]).toMatchObject({ provider: 'prov-a', model: 'model-vision', reasoning: { effort: 'low' }, maxOutputTokens: 1200 });

    // The user edits their tiers while the run waits for a person: the run's later calls keep its models.
    await setUser(alice.token, { standard: { model: 'prov-a:model-big', reasoningEffort: 'high', maxOutputTokens: 5000 } });
    Object.assign([...fabric.handoffs.values()][0]!, { status: 'completed', response: { outcome: 'completed', value: 'approve', value_withheld: false } });
    expect(await runner.advance(run.id, alice.userId, null)).toBe('succeeded');
    expect(runTools.mock.calls[1]![0]).toMatchObject({ provider: 'prov-a', model: 'model-vision', reasoning: { effort: 'low' }, maxOutputTokens: 1200 });
    expect((await db.run.findFirstOrThrow({ where: { id: run.id } })).policySnapshot).toMatchObject({ resolvedTiers: first.resolvedTiers });

    // A new run picks the change up.
    const next = await db.run.create({ data: { userId: alice.userId, goal: 'g' } });
    const second = scriptedAi([[['finish', { success: true, result: 'done' }]]]);
    expect(await runnerFor(second.ai, fakeFabric().client).advance(next.id, alice.userId, null)).toBe('succeeded');
    expect(second.runTools.mock.calls[0]![0]).toMatchObject({ model: 'model-big', reasoning: { effort: 'high' }, maxOutputTokens: 5000 });
  });

  it('starts a model without image input with screenshots off and makes no refused call', async () => {
    const alice = await login(`tiers-vision-${stamp}@example.test`);
    usable();
    await setUser(alice.token, { standard: { model: 'prov-a:model-text' } });
    const db = app.get(PrismaService).forUser({ userId: alice.userId });
    const run = await db.run.create({ data: { userId: alice.userId, goal: 'g' } });
    const fabric = fakeFabric();
    const { ai, runTools } = scriptedAi([[['navigate', { url: 'https://shop.example.test/', reason: 'open' }], ['finish', { success: true, result: 'done' }]]]);
    expect(await runnerFor(ai, fabric.client).advance(run.id, alice.userId, null)).toBe('succeeded');
    expect(runTools).toHaveBeenCalledTimes(1);
    expect(fabric.actionTypes).not.toContain('screenshot');
    const row = await db.run.findFirstOrThrow({ where: { id: run.id } });
    expect((row.transcript as { visionOff?: boolean }).visionOff).toBe(true);
    expect(JSON.stringify(row.transcript)).toContain('Screenshots are off');

    // A model with vision does take the screenshot.
    await setUser(alice.token, { standard: { model: 'prov-a:model-vision' } });
    const seeing = await db.run.create({ data: { userId: alice.userId, goal: 'g' } });
    const second = fakeFabric();
    expect(await runnerFor(scriptedAi([[['finish', { success: true, result: 'done' }]]]).ai, second.client).advance(seeing.id, alice.userId, null)).toBe('succeeded');
    expect(second.actionTypes).toContain('screenshot');
  });

  it('fails the run before a browser is allocated when the start tier has no usable model', async () => {
    const alice = await login(`tiers-fail-${stamp}@example.test`);
    usable();
    const db = app.get(PrismaService).forUser({ userId: alice.userId });

    // No model anywhere.
    const none = await db.run.create({ data: { userId: alice.userId, goal: 'g' } });
    const f1 = fakeFabric();
    const a = scriptedAi([]);
    expect(await runnerFor(a.ai, f1.client).advance(none.id, alice.userId, null)).toBe('failed');
    expect((await db.run.findFirstOrThrow({ where: { id: none.id } })).error).toMatch(/No model selected.*Model tiers/);
    expect(f1.sessions()).toBe(0);
    expect(a.runTools).not.toHaveBeenCalled();

    // A model that cannot call tools.
    await setUser(alice.token, { standard: { model: 'prov-a:model-notools' } });
    const bad = await db.run.create({ data: { userId: alice.userId, goal: 'g' } });
    expect(await runnerFor(scriptedAi([]).ai, fakeFabric().client).advance(bad.id, alice.userId, null)).toBe('failed');
    expect((await db.run.findFirstOrThrow({ where: { id: bad.id } })).error).toMatch(/does not support tool calls/);
  });
});
