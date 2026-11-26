import { agentPolicySpecSchema, type AgentPolicySpec, type Tier } from './agent-policy.schema';

/**
 * The built-in policies (#401): code, not rows. Read-only; duplicate one to
 * edit a copy. They never pin a model. Bump `version` when a value changes
 * (version 2: `maxWebCalls`, E50.7).
 */
export const BUILTIN_PREFIX = 'builtin:';
export const BUILTIN_KEYS = ['economy', 'balanced', 'thorough', 'unlimited'] as const;
export type BuiltinKey = (typeof BUILTIN_KEYS)[number];

/** What applies when nothing else names a policy. */
export const SYSTEM_DEFAULT_POLICY_REF = `${BUILTIN_PREFIX}balanced`;

export interface BuiltinPolicy {
  /** `builtin:<key>`. */
  id: string;
  key: BuiltinKey;
  name: string;
  description: string;
  version: number;
  spec: AgentPolicySpec;
}

interface Row {
  key: BuiltinKey;
  name: string;
  description: string;
  start: Tier;
  max: Tier;
  actions: number | null;
  calls: number | null;
  minutes: number | null;
  cost: number | null;
  /** Web searches and page reads (E50.7): a refused call over it, never a stop. */
  web: number | null;
  onStall: AgentPolicySpec['stall']['onStall'];
  escalations: number;
  screenshots: number;
}

const ROWS: readonly Row[] = [
  { key: 'economy', name: 'Economy', description: 'Cheap and quick: starts on the fast tier, small budgets.', start: 'fast', max: 'standard', actions: 40, calls: 80, minutes: 10, cost: 0.5, web: 10, onStall: 'nudge_then_escalate', escalations: 1, screenshots: 1 },
  { key: 'balanced', name: 'Balanced', description: 'The default: the standard tier, escalating to frontier when stuck.', start: 'standard', max: 'frontier', actions: 60, calls: 120, minutes: 20, cost: 2, web: 30, onStall: 'nudge_then_escalate', escalations: 2, screenshots: 2 },
  { key: 'thorough', name: 'Thorough', description: 'Hard tasks: the frontier tier throughout, generous budgets, asks a person when stuck.', start: 'frontier', max: 'frontier', actions: 200, calls: 400, minutes: 60, cost: 10, web: 100, onStall: 'ask_human', escalations: 0, screenshots: 3 },
  { key: 'unlimited', name: 'Unlimited', description: 'No budget limits. Runs until it finishes, you stop it or it stalls.', start: 'standard', max: 'frontier', actions: null, calls: null, minutes: null, cost: null, web: null, onStall: 'nudge_then_escalate', escalations: 2, screenshots: 2 },
];

function build(r: Row): BuiltinPolicy {
  const spec: AgentPolicySpec = {
    schemaVersion: 1,
    models: { startTier: r.start, maxTier: r.max, allowProviderFallback: true },
    budget: {
      maxActions: r.actions,
      maxModelCalls: r.calls,
      maxActiveMinutes: r.minutes,
      maxInputTokens: null,
      maxOutputTokens: null,
      maxCostUsd: r.cost,
      maxWebCalls: r.web,
      warnAtPercent: 80,
    },
    stall: { maxConsecutiveFailures: 4, maxRepeatedAction: 3, noProgressActions: 10, onStall: r.onStall, maxEscalations: r.escalations },
    context: { screenshotsKept: r.screenshots, pruneBatch: 10, callsPerChunk: r.key === 'economy' ? 8 : 10, observationChars: 6000 },
  };
  return { id: `${BUILTIN_PREFIX}${r.key}`, key: r.key, name: r.name, description: r.description, version: 2, spec: agentPolicySpecSchema.parse(spec) };
}

export const BUILTIN_POLICIES: readonly BuiltinPolicy[] = ROWS.map(build);

/** The built-in a ref names, or undefined. */
export function builtinPolicy(ref: string): BuiltinPolicy | undefined {
  return BUILTIN_POLICIES.find((p) => p.id === ref);
}

/** A deep copy of a built-in's spec, for duplicating or deriving from it. */
export function cloneSpec(spec: AgentPolicySpec): AgentPolicySpec {
  return structuredClone(spec);
}

/** The Balanced policy's spec (a copy): the base the legacy task fields derive from. */
export function balancedSpec(): AgentPolicySpec {
  return cloneSpec(builtinPolicy(SYSTEM_DEFAULT_POLICY_REF)!.spec);
}

export type PolicyRefKind = { kind: 'builtin'; key: BuiltinKey } | { kind: 'own'; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Classify a policy reference: `builtin:<key>` or a UUID; null for anything else. */
export function parsePolicyRef(ref: string): PolicyRefKind | null {
  if (ref.startsWith(BUILTIN_PREFIX)) {
    const key = ref.slice(BUILTIN_PREFIX.length) as BuiltinKey;
    return (BUILTIN_KEYS as readonly string[]).includes(key) ? { kind: 'builtin', key } : null;
  }
  return UUID.test(ref) ? { kind: 'own', id: ref.toLowerCase() } : null;
}
