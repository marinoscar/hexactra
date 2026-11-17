import { consoleApi } from './console-api.js';

/** The slice of an agent policy the CLI shows (the API returns the whole spec). */
export interface PolicyView {
  id: string;
  name: string;
  description: string | null;
  version: number;
  builtin: boolean;
  isDefault: boolean;
  hasNoHardStop: boolean;
  usage: { tasks: number; schedules: number };
  spec: {
    models: { startTier: string; maxTier: string; allowProviderFallback?: boolean };
    budget: {
      maxActions: number | null;
      maxModelCalls: number | null;
      maxActiveMinutes: number | null;
      maxInputTokens: number | null;
      maxOutputTokens: number | null;
      maxCostUsd: number | null;
      warnAtPercent: number;
    };
    [k: string]: unknown;
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUILTINS = ['economy', 'balanced', 'thorough', 'unlimited'];

/** A reference the API accepts as it is: a UUID or `builtin:<key>`. */
export const isPolicyRef = (v: string): boolean => UUID.test(v) || (v.startsWith('builtin:') && BUILTINS.includes(v.slice(8)));

/** `tiers` column: `fast -> standard`, or just the tier when both are the same. */
export const tierRange = (p: PolicyView): string => (p.spec.models.startTier === p.spec.models.maxTier ? p.spec.models.startTier : `${p.spec.models.startTier} -> ${p.spec.models.maxTier}`);

const lim = (v: number | null, unit = ''): string => (v === null ? 'unlimited' : `${v}${unit}`);

/** One line of limits; `null` is unlimited. */
export function budgetText(b: PolicyView['spec']['budget']): string {
  return [`${lim(b.maxActions)} actions`, `${lim(b.maxActiveMinutes)} min`, `${lim(b.maxModelCalls)} model calls`, b.maxCostUsd === null ? 'cost unlimited' : `$${b.maxCostUsd}`].join(', ');
}

/** The list line: id prefix (or builtin key), flags, tiers, budget summary. */
export function policyLine(p: PolicyView): string {
  const id = p.builtin ? p.id : p.id.slice(0, 8);
  const flags = [p.builtin ? 'built-in' : null, p.isDefault ? 'default' : null, p.hasNoHardStop ? 'no hard stop' : null].filter(Boolean).join(', ');
  return `${id.padEnd(18)}  ${p.name.padEnd(24)}  ${tierRange(p).padEnd(20)}  ${budgetText(p.spec.budget)}${flags ? `  [${flags}]` : ''}`;
}

/**
 * Find a policy by what a person types: the full id, `builtin:balanced` or
 * just `balanced`, an id prefix, or the exact name. Several matches are refused.
 */
export function findPolicy(list: PolicyView[], ref: string): PolicyView {
  const exact = list.find((p) => p.id === ref || p.id === `builtin:${ref}`);
  if (exact) return exact;
  const matches = list.filter((p) => (!p.builtin && p.id.startsWith(ref)) || p.name === ref);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`"${ref}" matches several policies; use the id`);
  throw new Error(`No policy matches "${ref}". Run \`policies list\`.`);
}

/** The id to send as `policyId`: a full reference as it is, otherwise looked up by name or prefix. */
export async function resolvePolicyId(ref: string): Promise<string> {
  if (isPolicyRef(ref)) return ref;
  return findPolicy(await consoleApi().get<PolicyView[]>('/agent-policies'), ref).id;
}

/** The run's policy, tier, budget and cost as short lines (only what the API reports). */
export interface RunPolicyFields {
  policy?: { id: string; name: string; version?: number; builtin?: boolean } | null;
  currentTier?: string | null;
  model?: string | null;
  costUsd?: number | string | null;
  costKnown?: boolean;
  modelCalls?: number | null;
  stopReason?: string | null;
  budget?: { effective?: unknown; used?: unknown; percent?: number | null; source?: unknown } | null;
}

export function costText(r: RunPolicyFields): string | null {
  if (r.costUsd === undefined || r.costUsd === null) return null;
  const n = Number(r.costUsd);
  if (!Number.isFinite(n)) return null;
  return `$${n.toFixed(n < 1 ? 4 : 2)}${r.costKnown === false ? '+ (some calls unpriced)' : ''}`;
}

export function runPolicyLines(r: RunPolicyFields): string[] {
  const lines: string[] = [];
  if (r.policy) lines.push(`policy: ${r.policy.name}${r.policy.version ? ` v${r.policy.version}` : ''}`);
  const tier = [r.currentTier ? `tier ${r.currentTier}` : null, r.model ? `model ${r.model}` : null].filter(Boolean).join(', ');
  if (tier) lines.push(tier);
  const cost = costText(r);
  if (cost) lines.push(`cost: ${cost}${r.modelCalls ? `, ${r.modelCalls} model calls` : ''}`);
  if (r.budget && typeof r.budget.percent === 'number') lines.push(`budget: ${Math.round(r.budget.percent)}% used`);
  if (r.stopReason) lines.push(`stopped: ${r.stopReason}`);
  return lines;
}
