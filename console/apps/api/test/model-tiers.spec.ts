// Model tiers (#403), the pure parts: the precedence and fill-down, the
// settings merges, placing models in the catalogue, the per-call request and
// the browser_agent target resolver.
import { DefaultAiTargetResolver, type AiTargetContext } from '@marinoscar/platform-api/ai';

import { BROWSER_AGENT_FEATURE_ID } from '../src/runner/browser-agent.feature';
import { FILL_DOWN_ORDER, MODEL_TIERS_PAGE, noModelMessage, selectTiers } from '../src/policies/model-tiers';
import { DEFAULT_MODEL_TIERS, EMPTY_TIER, mergeTierOverrides, modelTiersOverrideSchema, modelTiersSchema, platformEffort, type ModelTiers } from '../src/policies/model-tiers.schema';
import { BROWSER_AGENT_TIERS_SYSTEM_SETTINGS } from '../src/policies/model-tiers.settings';
import { place } from '../src/policies/model-tiers.service';
import { BROWSER_AGENT_USER_SETTINGS } from '../src/policies/policies.settings';
import { balancedSpec } from '../src/policies/builtin-policies';
import type { RunPolicySnapshot } from '../src/policies/policy-snapshot';
import { BrowserAgentTargetResolver } from '../src/platform/ai/browser-agent-target.resolver';
import { tierHasVision, tierProblem, tierRequest } from '../src/runner/tier-request';

const deployment = (patch: Partial<Record<'fast' | 'standard' | 'frontier', Partial<ModelTiers['fast']>>>): ModelTiers => ({
  fast: { ...EMPTY_TIER, ...patch.fast },
  standard: { ...EMPTY_TIER, ...patch.standard },
  frontier: { ...EMPTY_TIER, ...patch.frontier },
});

describe('tier selection', () => {
  it('resolves the model as pin > user > deployment > fill-down > ai.defaultModel', () => {
    const dep = deployment({ fast: { model: 'prov-a:dep-fast' }, standard: { model: 'prov-a:dep-std' }, frontier: { model: 'prov-a:dep-front' } });
    const user = { standard: { model: 'prov-a:user-std' } };
    const sel = selectTiers({ pins: { frontier: 'prov-a:pinned' }, user, deployment: dep, aiDefault: 'prov-a:ai-default' });
    expect(sel.frontier).toMatchObject({ model: 'prov-a:pinned', modelSource: 'pin' });
    expect(sel.standard).toMatchObject({ model: 'prov-a:user-std', modelSource: 'user' });
    expect(sel.fast).toMatchObject({ model: 'prov-a:dep-fast', modelSource: 'deployment' });

    // Fill-down, then the platform default, then nothing.
    const only = selectTiers({ deployment: deployment({ standard: { model: 'prov-a:dep-std' } }), aiDefault: 'prov-a:ai-default' });
    expect(only.fast).toMatchObject({ model: 'prov-a:dep-std', modelSource: 'fill_down', borrowedFrom: 'standard' });
    expect(only.frontier).toMatchObject({ model: 'prov-a:dep-std', modelSource: 'fill_down', borrowedFrom: 'standard' });
    const aiOnly = selectTiers({ aiDefault: 'prov-a:ai-default' });
    expect(aiOnly.standard).toMatchObject({ model: 'prov-a:ai-default', modelSource: 'ai_default' });
    const none = selectTiers({});
    expect(none.fast).toMatchObject({ model: null, modelSource: null });
  });

  it('fills down in the documented order and a pin never lends its model to another tier', () => {
    expect(FILL_DOWN_ORDER).toEqual({ fast: ['standard', 'frontier'], standard: ['frontier', 'fast'], frontier: ['standard', 'fast'] });
    // standard borrows frontier first, then fast.
    const a = selectTiers({ deployment: deployment({ frontier: { model: 'prov-a:big' }, fast: { model: 'prov-a:small' } }) });
    expect(a.standard).toMatchObject({ model: 'prov-a:big', borrowedFrom: 'frontier' });
    const b = selectTiers({ deployment: deployment({ fast: { model: 'prov-a:small' } }) });
    expect(b.standard).toMatchObject({ model: 'prov-a:small', borrowedFrom: 'fast' });
    expect(b.frontier).toMatchObject({ model: 'prov-a:small', borrowedFrom: 'fast' });
    // frontier with only fast set and a pin on standard: the pin stays on standard.
    const c = selectTiers({ pins: { standard: 'prov-a:pin' }, deployment: deployment({ fast: { model: 'prov-a:small' } }) });
    expect(c.standard).toMatchObject({ model: 'prov-a:pin', modelSource: 'pin' });
    expect(c.frontier).toMatchObject({ model: 'prov-a:small', borrowedFrom: 'fast' });
    // fast with only frontier set borrows frontier.
    expect(selectTiers({ deployment: deployment({ frontier: { model: 'prov-a:big' } }) }).fast).toMatchObject({ model: 'prov-a:big', borrowedFrom: 'frontier' });
  });

  it('takes effort, output cap and fallback from the user, then the deployment, and never borrows them', () => {
    const dep = deployment({ standard: { model: 'prov-a:m', reasoningEffort: 'low', maxOutputTokens: 2000, fallbackModel: 'prov-a:fb' }, frontier: { reasoningEffort: 'high' } });
    const sel = selectTiers({ user: { standard: { reasoningEffort: 'medium' }, frontier: { maxOutputTokens: 8000 } }, deployment: dep });
    expect(sel.standard).toMatchObject({ reasoningEffort: 'medium', effortSource: 'user', maxOutputTokens: 2000, maxOutputTokensSource: 'deployment', fallbackModel: 'prov-a:fb', fallbackSource: 'deployment' });
    // Same model, different effort: Frontier borrows Standard's model and keeps its own effort.
    expect(sel.frontier).toMatchObject({ model: 'prov-a:m', modelSource: 'fill_down', reasoningEffort: 'high', effortSource: 'deployment', maxOutputTokens: 8000, maxOutputTokensSource: 'user' });
    // Fast sets nothing: it does not inherit Standard's effort or cap.
    expect(sel.fast).toMatchObject({ model: 'prov-a:m', reasoningEffort: null, effortSource: null, maxOutputTokens: null, fallbackModel: null });
  });

  it('names the Model tiers page when no model is selected anywhere', () => {
    const none = selectTiers({});
    const resolved = place(none.standard, []);
    expect(resolved).toMatchObject({ model: null, usable: false });
    expect(resolved.problem).toBe(noModelMessage('standard'));
    expect(resolved.problem).toContain('No model selected');
    expect(resolved.problem).toContain(MODEL_TIERS_PAGE);
  });
});

describe('placing the models in the catalogue', () => {
  const catalogue = [
    { provider: 'prov-a', modelId: 'model-1', capabilities: ['tools', 'vision_input', 'reasoning'] },
    { provider: 'prov-a', modelId: 'text-only', capabilities: ['tools'] },
    { provider: 'prov-a', modelId: 'no-tools', capabilities: ['vision_input'] },
  ];
  const sel = (model: string | null, extra: Record<string, unknown> = {}) => selectTiers({ deployment: deployment({ standard: { model, ...extra } }) }).standard;

  it('places a model, with its provider, capability flags and canonical name', () => {
    expect(place(sel('model-1'), catalogue)).toMatchObject({ model: 'prov-a:model-1', provider: 'prov-a', modelId: 'model-1', vision: true, tools: true, reasoning: true, usable: true, problem: null });
  });

  it('allows a model without image input but flags it', () => {
    expect(place(sel('prov-a:text-only'), catalogue)).toMatchObject({ vision: false, tools: true, reasoning: false, usable: true });
  });

  it('refuses a model without tool calls and one that is not enabled, naming the tier', () => {
    expect(place(sel('no-tools'), catalogue)).toMatchObject({ usable: false, tools: false });
    expect(place(sel('no-tools'), catalogue).problem).toMatch(/does not support tool calls/);
    const unknown = place(sel('gone'), catalogue);
    expect(unknown).toMatchObject({ usable: false, provider: null });
    expect(unknown.problem).toMatch(/standard tier.*not an enabled model/);
  });

  it('accepts the names as set when there is no catalogue, and places the fallback', () => {
    expect(place(sel('prov-a:anything'), null)).toMatchObject({ model: 'prov-a:anything', provider: null, usable: true, vision: null });
    expect(place(sel('model-1', { fallbackModel: 'text-only' }), catalogue)).toMatchObject({ fallbackModel: 'prov-a:text-only', fallbackProvider: 'prov-a' });
  });
});

describe('the settings namespaces', () => {
  it('registers the deployment default with every tier unset, and merges a patch per tier and field', () => {
    const { merge, defaults } = BROWSER_AGENT_TIERS_SYSTEM_SETTINGS;
    expect(defaults).toEqual(DEFAULT_MODEL_TIERS);
    const one = merge(defaults, { standard: { model: 'prov-a:m', reasoningEffort: 'low' } });
    expect(one.standard).toEqual({ model: 'prov-a:m', reasoningEffort: 'low', maxOutputTokens: null, fallbackModel: null });
    const two = merge(one, { standard: { reasoningEffort: null }, frontier: { model: 'prov-a:big', maxOutputTokens: 4000 } });
    expect(two.standard).toEqual({ model: 'prov-a:m', reasoningEffort: null, maxOutputTokens: null, fallbackModel: null });
    expect(two.frontier).toMatchObject({ model: 'prov-a:big', maxOutputTokens: 4000 });
    expect(modelTiersSchema.safeParse(two).success).toBe(true);
  });

  it('rejects an output cap out of range and an unknown effort', () => {
    expect(modelTiersOverrideSchema.safeParse({ fast: { maxOutputTokens: 100 } }).success).toBe(false);
    expect(modelTiersOverrideSchema.safeParse({ fast: { maxOutputTokens: 64_001 } }).success).toBe(false);
    expect(modelTiersOverrideSchema.safeParse({ fast: { reasoningEffort: 'extreme' } }).success).toBe(false);
    expect(modelTiersOverrideSchema.safeParse({ fast: { model: 'prov-a:m', reasoningEffort: 'none', maxOutputTokens: 256 } }).success).toBe(true);
  });

  it('merges the user tiers per field, clears with null, and never stores an empty namespace', () => {
    const { merge } = BROWSER_AGENT_USER_SETTINGS;
    const a = merge(undefined, { tiers: { standard: { model: 'prov-a:m', reasoningEffort: 'low' } } });
    expect(a).toEqual({ defaultPolicyRef: null, tiers: { standard: { model: 'prov-a:m', reasoningEffort: 'low' } } });
    const b = merge(a, { tiers: { standard: { reasoningEffort: null }, frontier: { model: 'prov-a:big' } } });
    expect(b).toEqual({ defaultPolicyRef: null, tiers: { standard: { model: 'prov-a:m' }, frontier: { model: 'prov-a:big' } } });
    // The default policy and the tiers are independent.
    expect(merge(b, { defaultPolicyRef: 'builtin:thorough' })).toEqual({ defaultPolicyRef: 'builtin:thorough', tiers: b!.tiers });
    expect(merge(b, { defaultPolicyRef: null })).toEqual(b);
    expect(merge(b, { tiers: null })).toBeUndefined();
    expect(merge({ defaultPolicyRef: 'builtin:thorough', tiers: b!.tiers }, { tiers: null })).toEqual({ defaultPolicyRef: 'builtin:thorough' });
    expect(merge(b, { tiers: { standard: { model: null }, frontier: { model: null } } })).toBeUndefined();
    expect(mergeTierOverrides({ fast: { model: 'x' } }, { fast: { model: null } })).toBeUndefined();
  });
});

describe('the per-call request', () => {
  const snapshotWith = (tiers: RunPolicySnapshot['resolvedTiers']): RunPolicySnapshot => ({
    schemaVersion: 1,
    ref: 'builtin:balanced',
    name: 'Balanced',
    version: 1,
    builtin: true,
    source: 'system_default',
    spec: balancedSpec(),
    tiers: null,
    resolvedTiers: tiers,
    takenAt: new Date(0).toISOString(),
  });
  const cat = [{ provider: 'prov-a', modelId: 'model-1', capabilities: ['tools', 'vision_input', 'reasoning'] }, { provider: 'prov-a', modelId: 'plain', capabilities: ['tools'] }];
  const tiers = (std: Record<string, unknown>, front: Record<string, unknown> = {}) => {
    const s = selectTiers({ deployment: deployment({ standard: { model: 'prov-a:model-1', ...std }, frontier: { model: 'prov-a:model-1', ...front } }) });
    return { fast: place(s.fast, cat), standard: place(s.standard, cat), frontier: place(s.frontier, cat) };
  };

  it('gives the model, reasoning effort and output cap of the tier asked for', () => {
    const snap = snapshotWith(tiers({ reasoningEffort: 'low', maxOutputTokens: 1500 }, { reasoningEffort: 'high', maxOutputTokens: 6000 }));
    expect(tierRequest(snap, 'standard')).toEqual({ provider: 'prov-a', model: 'model-1', reasoning: { effort: 'low' }, maxOutputTokens: 1500, modelLabel: 'prov-a:model-1' });
    expect(tierRequest(snap, 'frontier')).toMatchObject({ model: 'model-1', reasoning: { effort: 'high' }, maxOutputTokens: 6000 });
  });

  it('maps effort none to the lowest the platform offers, and omits unset fields', () => {
    expect(platformEffort('none')).toBe('minimal');
    expect(platformEffort(null)).toBeNull();
    const snap = snapshotWith(tiers({ reasoningEffort: 'none' }));
    expect(tierRequest(snap, 'standard').reasoning).toEqual({ effort: 'minimal' });
    expect(tierRequest(snapshotWith(tiers({})), 'standard')).toEqual({ provider: 'prov-a', model: 'model-1', modelLabel: 'prov-a:model-1' });
  });

  it('does not send an effort to a model that cannot reason, and asks for no model when none was resolved', () => {
    const s = selectTiers({ deployment: deployment({ standard: { model: 'plain', reasoningEffort: 'high' } }) });
    const snap = snapshotWith({ fast: place(s.fast, cat), standard: place(s.standard, cat), frontier: place(s.frontier, cat) });
    expect(tierRequest(snap, 'standard')).not.toHaveProperty('reasoning');
    expect(tierRequest(snapshotWith(null), 'standard')).toEqual({ modelLabel: null });
    expect(tierRequest({ ...snapshotWith(null), resolvedTiers: undefined }, 'standard')).toEqual({ modelLabel: null });
  });

  it('reports vision and a tier that cannot be used', () => {
    const s = selectTiers({ deployment: deployment({ standard: { model: 'plain' }, frontier: { model: 'gone' } }) });
    const snap = snapshotWith({ fast: place(s.fast, cat), standard: place(s.standard, cat), frontier: place(s.frontier, cat) });
    expect(tierHasVision(snap, 'standard')).toBe(false);
    expect(tierProblem(snap, 'standard')).toBeNull();
    expect(tierProblem(snap, 'frontier')).toMatch(/not an enabled model/);
    expect(tierHasVision(snapshotWith(null), 'standard')).toBeNull();
    expect(tierProblem(snapshotWith(null), 'standard')).toBeNull();
  });
});

describe('the AI target resolver', () => {
  const defaultModel = { provider: 'prov-a', modelId: 'user-default' };
  const prisma = (ai: unknown) => ({ userSettings: { findUnique: jest.fn(async () => ({ value: ai === undefined ? {} : { ai } })) } });
  const usableModels = [
    { provider: 'prov-a', modelId: 'model-1' },
    { provider: 'prov-b', modelId: 'model-2' },
  ];
  const modules = (models = usableModels) => ({ get: () => ({ listForUser: async () => models, listForSystem: async () => models }) });
  const ctx = (feature: string | undefined, requested: AiTargetContext['requested'] = {}): AiTargetContext => ({ userId: 'user-1', feature, requested });

  it('returns the explicit model of a browser_agent call, placing a bare id on its provider', async () => {
    const r = new BrowserAgentTargetResolver(prisma({ defaultModel }) as never, modules() as never);
    expect(await r.resolve(ctx(BROWSER_AGENT_FEATURE_ID, { provider: 'prov-b', model: 'model-2' }))).toEqual({ provider: 'prov-b', model: 'model-2' });
    expect(await r.resolve(ctx(BROWSER_AGENT_FEATURE_ID, { model: 'model-2' }))).toEqual({ provider: 'prov-b', model: 'model-2' });
  });

  it('without a model, a browser_agent call uses the user default, or fails naming the Model tiers page', async () => {
    expect(await new BrowserAgentTargetResolver(prisma({ defaultModel }) as never, modules() as never).resolve(ctx(BROWSER_AGENT_FEATURE_ID))).toEqual({ provider: 'prov-a', model: 'user-default' });
    const none = new BrowserAgentTargetResolver(prisma({ defaultModel: null }) as never, modules() as never);
    await expect(none.resolve(ctx(BROWSER_AGENT_FEATURE_ID))).rejects.toMatchObject({ message: expect.stringContaining('No model selected') });
    await expect(none.resolve(ctx(BROWSER_AGENT_FEATURE_ID))).rejects.toMatchObject({ message: expect.stringContaining('Model tiers') });
  });

  it("answers any other feature exactly as the platform's default resolver does", async () => {
    const cases: { ai: unknown; requested: AiTargetContext['requested']; sole: string[] }[] = [
      { ai: { defaultModel }, requested: {}, sole: ['prov-a'] },
      { ai: { defaultModel }, requested: { model: 'x' }, sole: ['prov-a'] },
      { ai: { defaultModel }, requested: { provider: 'prov-z' }, sole: ['prov-a'] },
      { ai: { defaultModel }, requested: { provider: 'prov-a', model: 'x' }, sole: ['prov-a'] },
      { ai: { defaultModel: null }, requested: {}, sole: ['prov-a'] },
      { ai: { defaultModel: null }, requested: { model: 'x' }, sole: ['prov-a'] },
      { ai: undefined, requested: { model: 'x' }, sole: [] },
    ];
    for (const c of cases) {
      const reference = new DefaultAiTargetResolver(prisma(c.ai) as never, { ids: () => c.sole } as never, { perUserDefaultModel: true } as never);
      // The sole registered provider is the one provider the user can use in this fake.
      const mine = new BrowserAgentTargetResolver(prisma(c.ai) as never, modules(c.sole.map((p) => ({ provider: p, modelId: 'm' }))) as never);
      const ask = ctx('notes-summary', c.requested);
      const [want, got] = await Promise.allSettled([reference.resolve(ask), mine.resolve(ask)]);
      if (want.status === 'fulfilled') expect(got).toEqual({ status: 'fulfilled', value: want.value });
      else expect(got).toMatchObject({ status: 'rejected', reason: { message: (want.reason as Error).message } });
    }
  });
});
