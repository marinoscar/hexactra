// Fixtures for the agent policy tests: the built-ins as the API serves them
// (apps/api/src/policies/builtin-policies.ts) and one own policy.
import type { AgentPolicy, AgentPolicySpec, EffectiveTiers } from '../policies/types';

type Budget = AgentPolicySpec['budget'];

function spec(start: AgentPolicySpec['models']['startTier'], max: AgentPolicySpec['models']['maxTier'], budget: Partial<Budget>): AgentPolicySpec {
  return {
    schemaVersion: 1,
    models: { startTier: start, maxTier: max, allowProviderFallback: true },
    budget: { maxActions: null, maxModelCalls: null, maxActiveMinutes: null, maxInputTokens: null, maxOutputTokens: null, maxCostUsd: null, warnAtPercent: 80, ...budget },
    stall: { maxConsecutiveFailures: 4, maxRepeatedAction: 3, noProgressActions: 10, onStall: 'nudge_then_escalate', maxEscalations: 2 },
    context: { screenshotsKept: 2, pruneBatch: 10, callsPerChunk: 10, observationChars: 6000 },
  };
}

function builtin(key: string, name: string, s: AgentPolicySpec, extra: Partial<AgentPolicy> = {}): AgentPolicy {
  return {
    id: `builtin:${key}`,
    name,
    description: `${name} built-in`,
    version: 1,
    builtin: true,
    spec: s,
    isDefault: false,
    usage: { tasks: 0, schedules: 0 },
    hasNoHardStop: false,
    createdAt: null,
    updatedAt: null,
    ...extra,
  };
}

export const ECONOMY = builtin('economy', 'Economy', spec('fast', 'standard', { maxActions: 40, maxModelCalls: 80, maxActiveMinutes: 10, maxCostUsd: 0.5 }));
export const BALANCED = builtin('balanced', 'Balanced', spec('standard', 'frontier', { maxActions: 60, maxModelCalls: 120, maxActiveMinutes: 20, maxCostUsd: 2 }), {
  isDefault: true,
  usage: { tasks: 2, schedules: 1 },
});
export const THOROUGH = builtin('thorough', 'Thorough', spec('frontier', 'frontier', { maxActions: 200, maxModelCalls: 400, maxActiveMinutes: 60, maxCostUsd: 10 }));
export const UNLIMITED = builtin('unlimited', 'Unlimited', spec('standard', 'frontier', {}), { hasNoHardStop: true });

export const OWN_ID = '66666666-6666-4666-8666-666666666666';
export const OWN: AgentPolicy = {
  id: OWN_ID,
  name: 'Careful shopping',
  description: 'Frontier from the start',
  version: 3,
  builtin: false,
  spec: { ...spec('frontier', 'frontier', { maxActions: 120, maxActiveMinutes: 30, maxCostUsd: 4 }), models: { startTier: 'frontier', maxTier: 'frontier', allowProviderFallback: false, pins: { frontier: 'provider-a:model-big' } } },
  isDefault: false,
  usage: { tasks: 1, schedules: 0 },
  hasNoHardStop: false,
  createdAt: '2026-11-17T00:00:00Z',
  updatedAt: '2026-11-17T00:00:00Z',
};

export const POLICIES: AgentPolicy[] = [ECONOMY, BALANCED, THOROUGH, UNLIMITED, OWN];

const tier = (model: string, source: EffectiveTiers['fast']['modelSource']): EffectiveTiers['fast'] => ({
  model,
  provider: 'provider-a',
  modelSource: source,
  borrowedFrom: source === 'fill_down' ? 'standard' : null,
  reasoningEffort: null,
  maxOutputTokens: null,
  fallbackModel: null,
  vision: true,
  tools: true,
  usable: true,
  problem: null,
});

export const EFFECTIVE: EffectiveTiers = {
  fast: tier('provider-a:model-std', 'fill_down'),
  standard: tier('provider-a:model-std', 'deployment'),
  frontier: tier('provider-a:model-big', 'user'),
};

/** `GET /api/ai/models`: two tool-capable models (one without vision) and one without tools. */
export const AI_MODELS = [
  { provider: 'provider-a', modelId: 'model-std', displayName: 'Model Std', capabilities: { capabilities: ['tools', 'vision_input'], inputModalities: ['text', 'image'], outputModalities: ['text'] }, keySource: 'org' },
  { provider: 'provider-a', modelId: 'model-big', displayName: 'Model Big', capabilities: { capabilities: ['tools', 'vision_input'], inputModalities: ['text', 'image'], outputModalities: ['text'] }, keySource: 'org' },
  { provider: 'provider-b', modelId: 'model-text', displayName: 'Model Text', capabilities: { capabilities: ['tools'], inputModalities: ['text'], outputModalities: ['text'] }, keySource: 'org' },
  { provider: 'provider-b', modelId: 'model-chat', displayName: 'Model Chat', capabilities: { capabilities: [], inputModalities: ['text'], outputModalities: ['text'] }, keySource: 'org' },
];

/** The canned responses every policy page reads. */
export const POLICY_READS = {
  'GET /agent-policies': POLICIES,
  'GET /agent-policies/default': { policyId: 'builtin:balanced', explicit: false },
  'GET /agent-policies/model-tiers/effective': { policy: { id: 'builtin:balanced', name: 'Balanced', startTier: 'standard', maxTier: 'frontier' }, tiers: EFFECTIVE },
  'GET /ai/models': AI_MODELS,
};
