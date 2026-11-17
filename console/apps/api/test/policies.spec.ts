// Agent policies (#401), the pure parts: the spec schema, the built-ins, the
// resolution order and the legacy-field mapping.
import type { ZodType } from 'zod';

import { TIERS, agentPolicySpecSchema, hasNoHardStop, type AgentPolicySpec } from '../src/policies/agent-policy.schema';
import { BUILTIN_POLICIES, SYSTEM_DEFAULT_POLICY_REF, builtinPolicy, parsePolicyRef } from '../src/policies/builtin-policies';
import { isDefaultLimits, legacyTaskSpec } from '../src/policies/legacy-task-policy';
import { BROWSER_AGENT_USER_SETTINGS } from '../src/policies/policies.settings';
import { PolicyModelCheck, matchPin } from '../src/policies/policy-model-check';
import { PolicyResolver } from '../src/policies/policy.resolver';
import { readSnapshot, runView } from '../src/policies/policy-snapshot';
import type { PoliciesService, PolicyRecord } from '../src/policies/policies.service';
import { createPolicySchema, policyRefSchema } from '../src/policies/policies.schemas';
import { createTaskSchema, updateTaskSchema } from '../src/tasks/tasks.schemas';

const balanced = (): AgentPolicySpec => structuredClone(builtinPolicy(SYSTEM_DEFAULT_POLICY_REF)!.spec);

describe('the agent policy spec', () => {
  it('accepts all four built-ins, with the documented values', () => {
    expect(BUILTIN_POLICIES.map((p) => p.id)).toEqual(['builtin:economy', 'builtin:balanced', 'builtin:thorough', 'builtin:unlimited']);
    for (const p of BUILTIN_POLICIES) {
      expect(agentPolicySpecSchema.safeParse(p.spec).success).toBe(true);
      expect(p.spec.models.pins).toBeUndefined();
      expect(p.spec.stall).toMatchObject({ maxConsecutiveFailures: 4, maxRepeatedAction: 3, noProgressActions: 10 });
    }
    const [economy, bal, thorough, unlimited] = BUILTIN_POLICIES.map((p) => p.spec);
    expect([economy!.models.startTier, economy!.models.maxTier, economy!.budget.maxActions, economy!.budget.maxModelCalls, economy!.budget.maxActiveMinutes, economy!.budget.maxCostUsd]).toEqual(['fast', 'standard', 40, 80, 10, 0.5]);
    expect([bal!.models.startTier, bal!.models.maxTier, bal!.budget.maxActions, bal!.budget.maxModelCalls, bal!.budget.maxActiveMinutes, bal!.budget.maxCostUsd]).toEqual(['standard', 'frontier', 60, 120, 20, 2]);
    expect([thorough!.models.startTier, thorough!.models.maxTier, thorough!.budget.maxActions, thorough!.budget.maxActiveMinutes, thorough!.budget.maxCostUsd, thorough!.stall.onStall, thorough!.stall.maxEscalations]).toEqual(['frontier', 'frontier', 200, 60, 10, 'ask_human', 0]);
    expect(economy!.context).toMatchObject({ screenshotsKept: 1, pruneBatch: 10, callsPerChunk: 8 });
    expect(thorough!.context).toMatchObject({ screenshotsKept: 3, callsPerChunk: 10 });
    expect(hasNoHardStop(unlimited!)).toBe(true);
    expect(hasNoHardStop(bal!)).toBe(false);
    expect(unlimited!.stall.onStall).toBe('nudge_then_escalate');
  });

  it('rejects maxTier below startTier, negative budgets and an unknown schemaVersion', () => {
    const low = balanced();
    low.models.startTier = 'frontier';
    low.models.maxTier = 'fast';
    const r = agentPolicySpecSchema.safeParse(low);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('maxTier');

    for (const bad of [-1, 0, 1.5]) {
      const s = balanced();
      s.budget.maxActions = bad;
      expect(agentPolicySpecSchema.safeParse(s).success).toBe(false);
    }
    const cost = balanced();
    cost.budget.maxCostUsd = -0.5;
    expect(agentPolicySpecSchema.safeParse(cost).success).toBe(false);
    cost.budget.maxCostUsd = 0;
    expect(agentPolicySpecSchema.safeParse(cost).success).toBe(false);
    const minutes = balanced();
    minutes.budget.maxActiveMinutes = 10_081;
    expect(agentPolicySpecSchema.safeParse(minutes).success).toBe(false);

    expect(agentPolicySpecSchema.safeParse({ ...balanced(), schemaVersion: 2 }).success).toBe(false);
    expect(agentPolicySpecSchema.safeParse({ ...balanced(), schemaVersion: undefined }).success).toBe(false);
  });

  it('allows null (unlimited) for every budget and optional pins', () => {
    const s = balanced();
    s.budget = { ...s.budget, maxActions: null, maxModelCalls: null, maxActiveMinutes: null, maxInputTokens: null, maxOutputTokens: null, maxCostUsd: null };
    s.models.pins = { fast: null, standard: 'model-a' };
    expect(agentPolicySpecSchema.safeParse(s).success).toBe(true);
    expect(hasNoHardStop(s)).toBe(true);
  });

  it('describes every field (the editor and the MCP docs reuse the text)', () => {
    const missing: string[] = [];
    const walk = (schema: ZodType, path: string): void => {
      const def = (schema as unknown as { def: { type: string; shape?: Record<string, ZodType>; innerType?: ZodType } }).def;
      if (!schema.description) missing.push(path || '(root)');
      if (def.type === 'object' && def.shape) {
        for (const [k, v] of Object.entries(def.shape)) walk(v, path ? `${path}.${k}` : k);
      } else if ((def.type === 'optional' || def.type === 'nullable') && def.innerType) {
        // The description sits on the outermost wrapper; an object inside carries its own fields.
        const inner = (def.innerType as unknown as { def: { type: string; shape?: Record<string, ZodType>; innerType?: ZodType } }).def;
        if (inner.type === 'object' && inner.shape) for (const [k, v] of Object.entries(inner.shape)) walk(v, `${path}.${k}`);
      }
    };
    walk(agentPolicySpecSchema, '');
    expect(missing).toEqual([]);
  });

  it('wraps tiers in a fixed order', () => {
    expect(TIERS).toEqual(['fast', 'standard', 'frontier']);
  });
});

describe('policy references and the policy bodies', () => {
  it('accepts a UUID or a known built-in key only', () => {
    expect(parsePolicyRef('builtin:balanced')).toEqual({ kind: 'builtin', key: 'balanced' });
    expect(parsePolicyRef('builtin:nope')).toBeNull();
    expect(parsePolicyRef('3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e')).toEqual({ kind: 'own', id: '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e' });
    expect(parsePolicyRef('not-a-ref')).toBeNull();
    expect(policyRefSchema.safeParse('builtin:economy').success).toBe(true);
    expect(policyRefSchema.safeParse('x'.repeat(65)).success).toBe(false);
  });

  it('validates a create body with the full spec', () => {
    expect(createPolicySchema.safeParse({ name: 'Mine', spec: balanced() }).success).toBe(true);
    expect(createPolicySchema.safeParse({ name: '', spec: balanced() }).success).toBe(false);
    expect(createPolicySchema.safeParse({ name: 'Mine', spec: { ...balanced(), budget: undefined } }).success).toBe(false);
  });

  it('keeps the deprecated task limits and adds policyId', () => {
    expect(createTaskSchema.parse({ name: 'n', goal: 'g' })).toMatchObject({ maxSteps: 100, maxMinutes: 30 });
    expect(createTaskSchema.parse({ name: 'n', goal: 'g', policyId: 'builtin:thorough' }).policyId).toBe('builtin:thorough');
    expect(updateTaskSchema.parse({ policyId: null })).toEqual({ policyId: null });
    expect(updateTaskSchema.safeParse({ policyId: 'nope' }).success).toBe(false);
  });
});

describe('the legacy task fields', () => {
  it('derives a policy from Balanced: maxActions, maxActiveMinutes and a standard pin', () => {
    const plain = legacyTaskSpec({ maxSteps: 250, maxMinutes: 45, model: null });
    expect(plain.budget).toMatchObject({ maxActions: 250, maxActiveMinutes: 45, maxModelCalls: 120, maxCostUsd: 2 });
    expect(plain.models).toMatchObject({ startTier: 'standard', maxTier: 'frontier' });
    expect(plain.models.pins).toBeUndefined();

    const pinned = legacyTaskSpec({ maxSteps: 250, maxMinutes: 45, model: 'model-x' });
    expect(pinned.models).toMatchObject({ maxTier: 'standard', pins: { standard: 'model-x' } });
  });

  it('knows the defaults', () => {
    expect(isDefaultLimits({ maxSteps: 100, maxMinutes: 30, model: null })).toBe(true);
    expect(isDefaultLimits({ maxSteps: 101, maxMinutes: 30, model: null })).toBe(false);
    expect(isDefaultLimits({ maxSteps: 100, maxMinutes: 30, model: 'm' })).toBe(false);
  });
});

describe('policy resolution', () => {
  const U = 'user-1';
  const rec = (id: string, name = id): PolicyRecord => ({ id, name, description: null, version: 3, builtin: id.startsWith('builtin:'), spec: balanced(), createdAt: null, updatedAt: null });
  const OWN = new Map<string, PolicyRecord>();
  const policies = {
    find: jest.fn(async (_u: string, ref: string) => {
      const b = builtinPolicy(ref);
      return b ? { ...rec(ref, b.name), version: b.version, spec: b.spec } : (OWN.get(ref) ?? null);
    }),
    readDefaultRef: jest.fn(async () => userDefault),
  };
  let userDefault: string | null = null;
  const prisma = { task: { findFirst: jest.fn(async () => ({ policyRef: taskRef })) } };
  let taskRef: string | null = null;
  const resolver = new PolicyResolver(policies as unknown as PoliciesService, prisma as never);

  beforeEach(() => {
    OWN.clear();
    userDefault = null;
    taskRef = null;
    jest.clearAllMocks();
  });
  const own = (id: string) => OWN.set(id, rec(id, `Policy ${id}`));

  it('falls to builtin:balanced when nothing names a policy', async () => {
    const r = await resolver.forRun({ userId: U });
    expect(r).toMatchObject({ source: 'system_default', notes: [] });
    expect(r.policy.id).toBe('builtin:balanced');
  });

  it('uses the user default, then the task, then the schedule, then the run override, in that order', async () => {
    own('p-user');
    own('p-task');
    own('p-sched');
    own('p-run');
    userDefault = 'p-user';
    expect((await resolver.forRun({ userId: U })).policy.id).toBe('p-user');
    expect((await resolver.forRun({ userId: U })).source).toBe('user_default');

    taskRef = 'p-task';
    expect(await resolver.forRun({ userId: U, taskId: 't' })).toMatchObject({ source: 'task', policy: { id: 'p-task' } });

    expect(await resolver.forRun({ userId: U, taskId: 't', policyRef: 'p-sched', policySource: 'schedule' })).toMatchObject({ source: 'schedule', policy: { id: 'p-sched' } });

    expect(await resolver.forRun({ userId: U, taskId: 't', policyRef: 'p-run', policySource: 'run' })).toMatchObject({ source: 'run', policy: { id: 'p-run' } });
  });

  it('uses a task reference the caller already holds without reading the task', async () => {
    own('p-task');
    const r = await resolver.forRun({ userId: U, taskId: 't', taskPolicyRef: 'p-task' });
    expect(r.policy.id).toBe('p-task');
    expect(prisma.task.findFirst).not.toHaveBeenCalled();
  });

  it('falls through a deleted or foreign reference at every level, with a note, and never fails', async () => {
    own('p-user');
    userDefault = 'p-user';
    taskRef = 'gone-task';
    const r = await resolver.forRun({ userId: U, taskId: 't', policyRef: 'gone-run', policySource: 'run' });
    expect(r).toMatchObject({ source: 'user_default', policy: { id: 'p-user' } });
    expect(r.notes).toHaveLength(2);
    expect(r.notes[0]).toContain('gone-run');
    expect(r.notes[1]).toContain('gone-task');

    // A deleted default falls to the system default.
    userDefault = 'gone-default';
    const last = await resolver.forRun({ userId: U });
    expect(last).toMatchObject({ source: 'system_default', policy: { id: 'builtin:balanced' } });
    expect(last.notes).toHaveLength(1);
  });

  it('treats an error reading a policy like a missing one', async () => {
    policies.find.mockRejectedValueOnce(new Error('corrupt'));
    const r = await resolver.forRun({ userId: U, policyRef: 'p', policySource: 'run' });
    expect(r.source).toBe('system_default');
    expect(r.notes).toHaveLength(1);
  });

  it('snapshots the policy with its name, version and spec', async () => {
    const snap = resolver.snapshot(await resolver.forRun({ userId: U }), new Date('2026-01-01T00:00:00Z'));
    expect(snap).toMatchObject({ schemaVersion: 1, ref: 'builtin:balanced', name: 'Balanced', version: 1, builtin: true, source: 'system_default', tiers: null, takenAt: '2026-01-01T00:00:00.000Z' });
    expect(readSnapshot(JSON.parse(JSON.stringify(snap)))?.spec.budget.maxActions).toBe(60);
  });
});

describe('the run snapshot view', () => {
  it('replaces the raw policy columns with a summary, null before the first advance', () => {
    expect(runView({ id: 'r', policyRef: 'builtin:balanced', policyVersion: null, policySnapshot: null, policySource: 'run' })).toEqual({ id: 'r', policy: null });
    const snap = { schemaVersion: 1, ref: 'builtin:thorough', name: 'Thorough', version: 1, builtin: true, source: 'task', spec: builtinPolicy('builtin:thorough')!.spec, tiers: null, takenAt: '2026-01-01T00:00:00Z' };
    const v = runView({ id: 'r', policyRef: 'builtin:thorough', policyVersion: 1, policySnapshot: snap, policySource: 'task' });
    expect(v.policy).toEqual({ id: 'builtin:thorough', name: 'Thorough', version: 1, source: 'task', builtin: true });
    expect(v).not.toHaveProperty('policySnapshot');
  });
});

describe('model pins', () => {
  const models = [
    { provider: 'prov-a', modelId: 'model-1', capabilities: ['tools', 'vision_input'] },
    { provider: 'prov-a', modelId: 'text-only', capabilities: ['tools'] },
  ];
  const check = (list: typeof models | null) => {
    const svc = new PolicyModelCheck({ get: () => (list ? { listForUser: async () => list.map((m) => ({ ...m, capabilities: { capabilities: m.capabilities } })) } : null) } as never);
    return svc;
  };
  const withPins = (pins: AgentPolicySpec['models']['pins']): AgentPolicySpec => ({ ...balanced(), models: { ...balanced().models, pins } });

  it('matches provider:model first, then a bare model id', () => {
    expect(matchPin(models, 'prov-a:model-1')?.modelId).toBe('model-1');
    expect(matchPin(models, 'model-1')?.provider).toBe('prov-a');
    expect(matchPin(models, 'nope')).toBeNull();
  });

  it('reports an unknown or disabled model and one without vision', async () => {
    const problems = await check(models).check('u', withPins({ fast: 'gone', standard: 'text-only', frontier: 'prov-a:model-1' }));
    expect(problems.map((p) => [p.tier, p.reason])).toEqual([['fast', 'unknown_or_disabled'], ['standard', 'unsupported']]);
  });

  it('accepts anything but the format when the AI catalogue is not available', async () => {
    expect(await check(null).check('u', withPins({ standard: 'anything' }))).toEqual([]);
  });
});

describe('the browserAgent user settings namespace', () => {
  const { merge } = BROWSER_AGENT_USER_SETTINGS;
  it('merges as JSON Merge Patch and never stores an empty namespace', () => {
    expect(merge(undefined, { defaultPolicyRef: 'builtin:thorough' })).toEqual({ defaultPolicyRef: 'builtin:thorough' });
    expect(merge({ defaultPolicyRef: 'builtin:thorough' }, {})).toEqual({ defaultPolicyRef: 'builtin:thorough' });
    expect(merge({ defaultPolicyRef: 'builtin:thorough' }, { defaultPolicyRef: null })).toBeUndefined();
    expect(merge({ defaultPolicyRef: 'builtin:thorough' }, null)).toBeUndefined();
    expect(merge({ defaultPolicyRef: 'builtin:thorough' }, undefined)).toEqual({ defaultPolicyRef: 'builtin:thorough' });
  });
});
