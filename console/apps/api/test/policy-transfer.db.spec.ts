// Agent policy export and import (#402) against a real, migrated and seeded database.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { UsableModelsService } from '@marinoscar/platform-api/ai';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { createApp } from '../src/main';
import { balancedSpec } from '../src/policies/builtin-policies';
import type { AgentPolicySpec } from '../src/policies/agent-policy.schema';
import type { PolicyFile } from '../src/policies/policy-transfer';
import type { ImportPoliciesResponse } from '../src/policies/policy-transfer.schemas';
import { PrismaService } from '../src/prisma/prisma.service';

let app: NestFastifyApplication;
const stamp = `${Date.now()}`;

async function login(email: string, role: 'admin' | 'contributor' | 'viewer' = 'contributor'): Promise<{ token: string; userId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return { token, userId: me.json<{ data: { id: string } }>().data.id };
}
const as = (token: string) => ({ authorization: `Bearer ${token}` });
const data = <T,>(res: { json: <U>() => U }): T => res.json<{ data: T }>().data;
const errBody = (res: { json: <U>() => U }) => res.json<{ error?: { code?: string; message?: string; details?: Record<string, unknown> }; code?: string; message?: string; details?: Record<string, unknown> }>();
const errCode = (res: { json: <U>() => U }): string => errBody(res).error?.code ?? errBody(res).code ?? '';
const errDetails = (res: { json: <U>() => U }) => errBody(res).error?.details ?? errBody(res).details ?? {};

interface Policy { id: string; name: string; version: number; spec: AgentPolicySpec; description: string | null }

function spec(change: (s: AgentPolicySpec) => void = () => undefined): AgentPolicySpec {
  const s = balancedSpec();
  change(s);
  return s;
}

const usable = (list: { provider: string; modelId: string; capabilities: string[] }[]) =>
  jest.spyOn(app.get(UsableModelsService, { strict: false }), 'listForUser').mockResolvedValue(
    list.map((m) => ({ provider: m.provider, modelId: m.modelId, displayName: null, capabilities: { capabilities: m.capabilities, inputModalities: ['text'], outputModalities: ['text'] }, keySource: 'org' })) as never,
  );

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
});
afterEach(() => jest.restoreAllMocks());

async function createPolicy(token: string, name: string, s: AgentPolicySpec = spec(), description?: string): Promise<Policy> {
  const res = await app.inject({ method: 'POST', url: '/api/agent-policies', headers: as(token), payload: { name, spec: s, ...(description ? { description } : {}) } });
  expect(res.statusCode).toBe(201);
  return data<Policy>(res);
}
const list = async (token: string): Promise<Policy[]> => data<Policy[]>(await app.inject({ method: 'GET', url: '/api/agent-policies', headers: as(token) })).filter((p) => !p.id.startsWith('builtin:'));
const exportFile = async (token: string, query = 'ids=all'): Promise<PolicyFile> => {
  const res = await app.inject({ method: 'GET', url: `/api/agent-policies/export?${query}`, headers: as(token) });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as PolicyFile;
};
const importFile = (token: string, file: unknown, onConflict?: string) =>
  app.inject({ method: 'POST', url: '/api/agent-policies/import', headers: as(token), payload: { file, ...(onConflict ? { onConflict } : {}) } });
const file = (policies: unknown[]) => ({ kind: 'hexactra.agent-policies', formatVersion: 1, exportedAt: new Date().toISOString(), policies });

describe('GET /api/agent-policies/export', () => {
  it('sends the file as a JSON attachment, not in the data envelope, and does not collide with :id', async () => {
    const alice = await login(`pt-export-${stamp}@example.test`);
    const mine = await createPolicy(alice.token, 'Careful shopping', spec((s) => { s.budget.maxActions = 77; }), 'Ask a person when stuck');

    const res = await app.inject({ method: 'GET', url: `/api/agent-policies/export?ids=${mine.id}`, headers: as(alice.token) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    const stamped = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    expect(res.headers['content-disposition']).toMatch(new RegExp(`^attachment; filename="agent-policies-\\d{8}\\.json"$`));
    expect(res.headers['content-disposition']).toContain(`agent-policies-${stamped}`);
    const body = JSON.parse(res.body) as PolicyFile;
    expect(body).toMatchObject({ kind: 'hexactra.agent-policies', formatVersion: 1 });
    expect(body).not.toHaveProperty('data');
    expect(body.policies).toEqual([{ name: 'Careful shopping', description: 'Ask a person when stuck', spec: mine.spec }]);
    // The file holds no ids or user ids: scan every key and value.
    expect(res.body).not.toContain(mine.id);
    expect(res.body).not.toContain(alice.userId);
    // The static route never shadows (or is shadowed by) the :id routes.
    expect((await app.inject({ method: 'GET', url: '/api/agent-policies/builtin:economy', headers: as(alice.token) })).statusCode).toBe(200);
    expect(errCode(await app.inject({ method: 'GET', url: '/api/agent-policies/nope', headers: as(alice.token) }))).toBe('POLICY_NOT_FOUND');
  });

  it('exports all (built-ins first, then your own), and a built-in on its own as a template', async () => {
    const alice = await login(`pt-all-${stamp}@example.test`);
    await createPolicy(alice.token, 'Mine');
    const all = await exportFile(alice.token);
    expect(all.policies.map((p) => p.name)).toEqual(['Economy', 'Balanced', 'Thorough', 'Unlimited', 'Mine']);
    expect((await exportFile(alice.token)).policies).toEqual(all.policies);
    expect((await exportFile(alice.token, 'ids=builtin:economy')).policies.map((p) => p.name)).toEqual(['Economy']);
    const dedup = await exportFile(alice.token, 'ids=builtin:thorough,builtin:economy,builtin:thorough');
    expect(dedup.policies.map((p) => p.name)).toEqual(['Thorough', 'Economy']);
  });

  it('keeps model pins by default and strips them with includePins=false', async () => {
    const alice = await login(`pt-pins-${stamp}@example.test`);
    usable([{ provider: 'prov-a', modelId: 'model-1', capabilities: ['tools', 'vision_input'] }]);
    const pinned = await createPolicy(alice.token, 'Pinned', spec((s) => { s.models.pins = { standard: 'prov-a:model-1' }; }));
    expect((await exportFile(alice.token, `ids=${pinned.id}`)).policies[0]!.spec.models.pins).toEqual({ standard: 'prov-a:model-1' });
    const bare = await app.inject({ method: 'GET', url: `/api/agent-policies/export?ids=${pinned.id}&includePins=false`, headers: as(alice.token) });
    expect(bare.body).not.toContain('model-1');
    expect((JSON.parse(bare.body) as PolicyFile).policies[0]!.spec.models).not.toHaveProperty('pins');
    expect((await app.inject({ method: 'GET', url: '/api/agent-policies/export?includePins=maybe', headers: as(alice.token) })).statusCode).toBe(400);
  });

  it('answers 404 for a policy that is not yours, and never exports another user\'s', async () => {
    const alice = await login(`pt-iso-a-${stamp}@example.test`);
    const bob = await login(`pt-iso-b-${stamp}@example.test`);
    const secret = await createPolicy(alice.token, 'Alice only');
    const res = await app.inject({ method: 'GET', url: `/api/agent-policies/export?ids=${secret.id}`, headers: as(bob.token) });
    expect(res.statusCode).toBe(404);
    expect(errCode(res)).toBe('POLICY_NOT_FOUND');
    expect((await exportFile(bob.token)).policies.map((p) => p.name)).not.toContain('Alice only');
  });
});

describe('POST /api/agent-policies/import', () => {
  it('lets user B import what user A exported: B owns copies and A is untouched', async () => {
    const alice = await login(`pt-share-a-${stamp}@example.test`);
    const bob = await login(`pt-share-b-${stamp}@example.test`);
    const a1 = await createPolicy(alice.token, 'Shared one', spec((s) => { s.budget.maxCostUsd = 1.25; }), 'first');
    const a2 = await createPolicy(alice.token, 'Shared two', spec((s) => { s.models.startTier = 'frontier'; s.models.maxTier = 'frontier'; }));
    const before = await list(alice.token);

    const exported = await exportFile(alice.token, `ids=${a1.id},${a2.id}`);
    const res = await importFile(bob.token, exported);
    expect(res.statusCode).toBe(201);
    const out = data<ImportPoliciesResponse>(res);
    expect(out).toMatchObject({ replaced: [], skipped: [], warnings: [], errors: [] });
    expect(out.created.map((c) => [c.index, c.name, c.renamedFrom])).toEqual([[0, 'Shared one', null], [1, 'Shared two', null]]);

    const mine = await list(bob.token);
    expect(mine.map((p) => p.name)).toEqual(['Shared one', 'Shared two']);
    expect(mine.map((p) => p.spec)).toEqual([a1.spec, a2.spec]);
    expect(mine[0]).toMatchObject({ version: 1, description: 'first' });
    expect(mine.map((p) => p.id)).not.toContain(a1.id);
    // The import never touched A.
    expect(await list(alice.token)).toEqual(before);
    // And each is B's own: A cannot read B's copy.
    expect((await app.inject({ method: 'GET', url: `/api/agent-policies/${out.created[0]!.id}`, headers: as(alice.token) })).statusCode).toBe(404);
  });

  it('defaults to rename: appends (2), (3), and renames among the file\'s own names too', async () => {
    const bob = await login(`pt-rename-${stamp}@example.test`);
    await createPolicy(bob.token, 'Taken');
    await createPolicy(bob.token, 'Taken (2)');
    const res = await importFile(bob.token, file([{ name: 'Taken', spec: spec() }, { name: 'Free', spec: spec() }]));
    expect(res.statusCode).toBe(201);
    expect(data<ImportPoliciesResponse>(res).created.map((c) => [c.name, c.renamedFrom])).toEqual([['Taken (3)', 'Taken'], ['Free', null]]);
    const again = data<ImportPoliciesResponse>(await importFile(bob.token, file([{ name: 'Taken', spec: spec() }]), 'rename'));
    expect(again.created[0]!.name).toBe('Taken (4)');
    expect((await list(bob.token)).map((p) => p.name).sort()).toEqual(['Free', 'Taken', 'Taken (2)', 'Taken (3)', 'Taken (4)']);
  });

  it('skip leaves the user\'s policy as it is and lists the entry as skipped', async () => {
    const bob = await login(`pt-skip-${stamp}@example.test`);
    const own = await createPolicy(bob.token, 'Keep me', spec((s) => { s.budget.maxActions = 11; }));
    const res = await importFile(bob.token, file([{ name: 'Keep me', spec: spec((s) => { s.budget.maxActions = 99; }) }, { name: 'New one', spec: spec() }]), 'skip');
    const out = data<ImportPoliciesResponse>(res);
    expect(out.skipped).toEqual([{ index: 0, name: 'Keep me', reason: 'name_taken' }]);
    expect(out.created.map((c) => c.name)).toEqual(['New one']);
    const kept = (await list(bob.token)).find((p) => p.id === own.id)!;
    expect(kept).toMatchObject({ version: 1 });
    expect(kept.spec.budget.maxActions).toBe(11);
  });

  it('replace overwrites the same-named policy in place, bumps its version, and keeps its id and its uses', async () => {
    const bob = await login(`pt-replace-${stamp}@example.test`);
    const own = await createPolicy(bob.token, 'Overwrite me', spec((s) => { s.budget.maxActions = 11; }), 'old');
    const task = data<{ id: string }>(await app.inject({ method: 'POST', url: '/api/tasks', headers: as(bob.token), payload: { name: 'Uses it', goal: 'g', policyId: own.id } }));
    const res = await importFile(bob.token, file([{ name: 'Overwrite me', description: 'new', spec: spec((s) => { s.budget.maxActions = 99; }) }]), 'replace');
    expect(data<ImportPoliciesResponse>(res)).toMatchObject({ created: [], replaced: [{ index: 0, id: own.id, name: 'Overwrite me', version: 2 }], skipped: [] });
    const now = data<Policy>(await app.inject({ method: 'GET', url: `/api/agent-policies/${own.id}`, headers: as(bob.token) }));
    expect(now).toMatchObject({ version: 2, description: 'new' });
    expect(now.spec.budget.maxActions).toBe(99);
    expect(data<{ policyId: string }>(await app.inject({ method: 'GET', url: `/api/tasks/${task.id}`, headers: as(bob.token) })).policyId).toBe(own.id);
  });

  it('is atomic: an invalid entry rejects the whole file with 400 POLICY_IMPORT_INVALID and creates nothing', async () => {
    const bob = await login(`pt-atomic-${stamp}@example.test`);
    const own = await createPolicy(bob.token, 'Existing');
    const bad = spec((s) => { (s.budget as { maxActions: number }).maxActions = 0; });
    for (const mode of ['rename', 'skip', 'replace']) {
      const res = await importFile(bob.token, file([{ name: 'Valid first', spec: spec() }, { name: 'Existing', spec: spec((s) => { s.budget.maxActions = 5; }) }, { name: 'Broken', spec: bad }]), mode);
      expect(res.statusCode).toBe(400);
      expect(errCode(res)).toBe('POLICY_IMPORT_INVALID');
      const details = errDetails(res) as { errors: { index: number; name: string; issues: { path: string; message: string }[] }[] };
      expect(details.errors).toHaveLength(1);
      expect(details.errors[0]).toMatchObject({ index: 2, name: 'Broken' });
      expect(details.errors[0]!.issues[0]!.path).toBe('spec.budget.maxActions');
    }
    expect((await list(bob.token)).map((p) => [p.name, p.version])).toEqual([['Existing', 1]]);
    expect((await list(bob.token))[0]!.id).toBe(own.id);
  });

  it('is atomic in the database too: a failure after the first write rolls every write back', async () => {
    const bob = await login(`pt-rollback-${stamp}@example.test`);
    await createPolicy(bob.token, 'Pre-existing', spec((s) => { s.budget.maxActions = 11; }));
    const prisma = app.get(PrismaService);
    const real = prisma.forUser.bind(prisma);
    jest.spyOn(prisma, 'forUser').mockImplementation((scope) => {
      const client = real(scope);
      return new Proxy(client, {
        get(target, key) {
          if (key !== '$transaction') return (target as never)[key];
          return (fn: (tx: never) => unknown, ...rest: unknown[]) =>
            (target.$transaction as (...a: unknown[]) => unknown)(
              (tx: Record<string, unknown>) => {
                let writes = 0;
                const policyModel = tx.agentPolicy as Record<string, (...a: unknown[]) => unknown>;
                const counted = new Proxy(policyModel, {
                  get: (m, name: string) => (name === 'create' || name === 'update' ? (...a: unknown[]) => { if (++writes === 3) throw new Error('boom'); return m[name]!(...a); } : m[name]),
                });
                return fn(new Proxy(tx, { get: (t, k) => (k === 'agentPolicy' ? counted : t[k as string]) }) as never);
              },
              ...rest,
            );
        },
      });
    });
    const res = await importFile(bob.token, file([{ name: 'One', spec: spec() }, { name: 'Two', spec: spec() }, { name: 'Pre-existing', spec: spec((s) => { s.budget.maxActions = 99; }) }]), 'replace');
    expect(res.statusCode).toBe(500);
    jest.restoreAllMocks();
    const after = await list(bob.token);
    expect(after.map((p) => [p.name, p.version, p.spec.budget.maxActions])).toEqual([['Pre-existing', 1, 11]]);
  });

  it('refuses a file from a newer format or spec version with 400 and a clear message', async () => {
    const bob = await login(`pt-version-${stamp}@example.test`);
    const newer = await importFile(bob.token, { ...file([{ name: 'F', spec: spec() }]), formatVersion: 2 });
    expect(newer.statusCode).toBe(400);
    expect(errCode(newer)).toBe('POLICY_IMPORT_UNSUPPORTED_VERSION');
    expect(errBody(newer).error?.message ?? errBody(newer).message).toMatch(/format version 2.*up to version 1/);
    const newerSpec = await importFile(bob.token, file([{ name: 'S', spec: { ...spec(), schemaVersion: 2 } }]));
    expect(newerSpec.statusCode).toBe(400);
    expect(errCode(newerSpec)).toBe('POLICY_IMPORT_UNSUPPORTED_VERSION');
    expect(await list(bob.token)).toEqual([]);
  });

  it('refuses an oversize body and more than 100 policies', async () => {
    const bob = await login(`pt-size-${stamp}@example.test`);
    const padded = { ...file([{ name: 'Big', spec: spec() }]), padding: 'x'.repeat(300 * 1024) };
    const big = await importFile(bob.token, padded);
    expect(big.statusCode).toBe(413);
    expect(errCode(big)).toBe('POLICY_IMPORT_TOO_LARGE');
    const huge = await importFile(bob.token, { ...padded, padding: 'x'.repeat(2 * 1024 * 1024) });
    expect(huge.statusCode).toBe(413);
    const many = await importFile(bob.token, file(Array.from({ length: 101 }, (_, i) => ({ name: `P${i}`, spec: spec() }))));
    expect(many.statusCode).toBe(400);
    expect(errCode(many)).toBe('POLICY_IMPORT_INVALID');
    expect(await list(bob.token)).toEqual([]);
    // 100 is fine, and a file that is not an export is a 400.
    const hundred = await importFile(bob.token, file(Array.from({ length: 100 }, (_, i) => ({ name: `P${i}`, spec: spec() }))));
    expect(hundred.statusCode).toBe(201);
    expect((await importFile(bob.token, { hello: 'world' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/agent-policies/import', headers: as(bob.token), payload: { file: 'text' } })).statusCode).toBe(400);
  });

  it('drops a pin to an unknown or disabled model with a warning, and creates the rest of the policy', async () => {
    const bob = await login(`pt-drop-${stamp}@example.test`);
    usable([
      { provider: 'prov-a', modelId: 'model-1', capabilities: ['tools', 'vision_input'] },
      { provider: 'prov-a', modelId: 'text-only', capabilities: ['tools'] },
    ]);
    const pins = { fast: 'prov-a:model-1', standard: 'gone-model', frontier: 'text-only' };
    const res = await importFile(bob.token, file([{ name: 'Pinned', spec: spec((s) => { s.models.pins = pins; s.budget.maxActions = 33; }) }, { name: 'All gone', spec: spec((s) => { s.models.pins = { standard: 'gone-model' }; }) }]));
    expect(res.statusCode).toBe(201);
    const out = data<ImportPoliciesResponse>(res);
    expect(out.created.map((c) => c.name)).toEqual(['Pinned', 'All gone']);
    expect(out.warnings.map((w) => [w.index, w.code])).toEqual([[0, 'PIN_DROPPED'], [0, 'PIN_DROPPED'], [1, 'PIN_DROPPED']]);
    expect(out.warnings[0]!.message).toContain('gone-model');
    const stored = await list(bob.token);
    const pinned = stored.find((p) => p.name === 'Pinned')!;
    expect(pinned.spec.models.pins).toEqual({ fast: 'prov-a:model-1' });
    expect(pinned.spec.budget.maxActions).toBe(33);
    expect(stored.find((p) => p.name === 'All gone')!.spec.models).not.toHaveProperty('pins');
  });

  it('drops every pin when this deployment has no usable model at all', async () => {
    const bob = await login(`pt-nopins-${stamp}@example.test`);
    // The real catalogue of this database: AI is not set up.
    const res = await importFile(bob.token, file([{ name: 'Foreign pin', spec: spec((s) => { s.models.pins = { standard: 'someone-elses-model' }; }) }]));
    expect(res.statusCode).toBe(201);
    expect(data<ImportPoliciesResponse>(res).warnings).toHaveLength(1);
    expect((await list(bob.token))[0]!.spec.models).not.toHaveProperty('pins');
  });

  it('accepts budgets above the deployment ceilings as stored, with a warning each', async () => {
    const bob = await login(`pt-ceiling-${stamp}@example.test`);
    const settings = app.get(SystemSettingsService, { strict: false });
    const getNamespace = settings.getNamespace.bind(settings) as (k: string) => Promise<unknown>;
    jest.spyOn(settings, 'getNamespace').mockImplementation(((key: string) => (key === 'browserAgentCeilings' ? Promise.resolve({ maxActions: 100, maxCostUsd: 5 }) : getNamespace(key))) as never);
    const res = await importFile(bob.token, file([
      { name: 'Within', spec: spec((s) => { s.budget.maxActions = 100; s.budget.maxCostUsd = 5; }) },
      { name: 'Over', spec: spec((s) => { s.budget.maxActions = 500; s.budget.maxCostUsd = null; }) },
    ]));
    expect(res.statusCode).toBe(201);
    const out = data<ImportPoliciesResponse>(res);
    expect(out.created.map((c) => c.name)).toEqual(['Within', 'Over']);
    expect(out.warnings.map((w) => [w.index, w.name, w.code])).toEqual([[1, 'Over', 'EXCEEDS_CEILING'], [1, 'Over', 'EXCEEDS_CEILING']]);
    expect(out.warnings[0]!.message).toMatch(/maxActions is 500.*ceiling of 100/);
    expect(out.warnings[1]!.message).toMatch(/maxCostUsd is unlimited.*ceiling of 5/);
    // Stored as written: the budget engine clamps at run time.
    expect((await list(bob.token)).find((p) => p.name === 'Over')!.spec.budget).toMatchObject({ maxActions: 500, maxCostUsd: null });
  });

  it('imports without warnings while no ceiling namespace exists', async () => {
    const bob = await login(`pt-noceil-${stamp}@example.test`);
    const res = await importFile(bob.token, file([{ name: 'Unlimited', spec: spec((s) => { s.budget.maxActions = null; }) }]));
    expect(data<ImportPoliciesResponse>(res).warnings).toEqual([]);
  });

  it('exports a user\'s round trip to an identical spec through the API', async () => {
    const bob = await login(`pt-round-${stamp}@example.test`);
    const src = await createPolicy(bob.token, 'Round trip', spec((s) => { s.stall.onStall = 'ask_human'; s.context.screenshotsKept = 4; s.budget.maxInputTokens = 123_456; }));
    const exported = await exportFile(bob.token, `ids=${src.id}`);
    const copy = data<ImportPoliciesResponse>(await importFile(bob.token, exported));
    expect(copy.created[0]!.name).toBe('Round trip (2)');
    const copied = (await list(bob.token)).find((p) => p.id === copy.created[0]!.id)!;
    expect(copied.spec).toEqual(src.spec);
  });

  it('enforces the permissions: a viewer exports but cannot import, and nobody anonymous does either', async () => {
    const viewer = await login(`pt-viewer-${stamp}@example.test`, 'viewer');
    expect((await app.inject({ method: 'GET', url: '/api/agent-policies/export', headers: as(viewer.token) })).statusCode).toBe(200);
    expect((await importFile(viewer.token, file([{ name: 'X', spec: spec() }]))).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/agent-policies/export' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/agent-policies/import', payload: { file: file([]) } })).statusCode).toBe(401);
  });

  it('lists both routes in the OpenAPI document', async () => {
    const doc = (await app.inject({ method: 'GET', url: '/api/openapi.json' })).json<{ paths: Record<string, Record<string, unknown>> }>();
    expect(doc.paths['/api/agent-policies/export']).toHaveProperty('get');
    expect(doc.paths['/api/agent-policies/import']).toHaveProperty('post');
  });
});

describe('the user-scoped transaction the import relies on', () => {
  it('confines a forUser transaction client to the user\'s own rows', async () => {
    const alice = await login(`pt-scope-a-${stamp}@example.test`);
    const bob = await login(`pt-scope-b-${stamp}@example.test`);
    await createPolicy(alice.token, 'A row');
    await createPolicy(bob.token, 'B row');
    const prisma = app.get(PrismaService);
    const seen = await prisma.forUser({ userId: alice.userId }).$transaction(async (tx) => tx.agentPolicy.findMany({ select: { userId: true, name: true } }));
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen.map((r) => r.userId))).toEqual(new Set([alice.userId]));
  });
});
