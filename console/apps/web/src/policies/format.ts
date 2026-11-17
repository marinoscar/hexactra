// Presentation helpers for agent policies: summaries, labels and the model a
// task will start on. Pure; no decisions the API makes (it validates and
// enforces every value).
import {
  BUDGET_LIMIT_KEYS,
  TIERS,
  TIER_LABEL,
  type AgentPolicy,
  type AgentPolicySpec,
  type BudgetCeilings,
  type BudgetLimitKey,
  type EffectiveTier,
  type EffectiveTiers,
  type ModelSource,
  type StallAction,
  type Tier,
} from './types';
import type { PolicyCatalog } from './usePolicyCatalog';
import type { Task } from '../types/tasks';

export const BUDGET_LABEL: Record<BudgetLimitKey, string> = {
  maxActions: 'Browser actions',
  maxModelCalls: 'Model calls',
  maxActiveMinutes: 'Active minutes',
  maxInputTokens: 'Input tokens',
  maxOutputTokens: 'Output tokens',
  maxCostUsd: 'Cost (US$)',
};

export const STALL_LABEL: Record<StallAction, string> = {
  nudge_then_escalate: 'Nudge the model, then escalate a tier',
  escalate: 'Escalate a tier at once',
  ask_human: 'Ask me (a person) what to do',
  fail: 'Fail the run',
};

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** One budget value as a short phrase: "60 actions", "$2", "20 min". */
export function budgetPhrase(key: BudgetLimitKey, value: number): string {
  switch (key) {
    case 'maxActions':
      return `${compact.format(value)} actions`;
    case 'maxModelCalls':
      return `${compact.format(value)} model calls`;
    case 'maxActiveMinutes':
      return `${compact.format(value)} min`;
    case 'maxInputTokens':
      return `${compact.format(value)} input tokens`;
    case 'maxOutputTokens':
      return `${compact.format(value)} output tokens`;
    case 'maxCostUsd':
      return `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
  }
}

/**
 * The list row's budget summary: "60 actions · $2 · 20 min", or "Unlimited"
 * when no limit is set. Actions, cost and time lead; the other limits show
 * only when none of those three is set.
 */
export function budgetSummary(spec: AgentPolicySpec): string {
  const lead = (['maxActions', 'maxCostUsd', 'maxActiveMinutes'] as const).filter((k) => spec.budget[k] !== null);
  const keys = lead.length > 0 ? lead : BUDGET_LIMIT_KEYS.filter((k) => spec.budget[k] !== null);
  if (keys.length === 0) return 'Unlimited';
  return keys.map((k) => budgetPhrase(k, spec.budget[k]!)).join(' · ');
}

/** True when no budget limit is set (mirrors the API's `hasNoHardStop`, for the editor's unsaved state). */
export function hasNoHardStop(spec: AgentPolicySpec): boolean {
  return BUDGET_LIMIT_KEYS.every((k) => spec.budget[k] === null);
}

export function tierRange(spec: AgentPolicySpec): string {
  const { startTier, maxTier } = spec.models;
  return startTier === maxTier ? TIER_LABEL[startTier] : `${TIER_LABEL[startTier]} → ${TIER_LABEL[maxTier]}`;
}

export function usageText(p: Pick<AgentPolicy, 'usage'>): string {
  const t = p.usage.tasks;
  const s = p.usage.schedules;
  return `Used by ${t} ${t === 1 ? 'task' : 'tasks'}, ${s} ${s === 1 ? 'schedule' : 'schedules'}`;
}

/** One line under a policy picker: tiers and budget. */
export function policyLine(p: AgentPolicy): string {
  return `${tierRange(p.spec)} · ${budgetSummary(p.spec)}`;
}

export function tierRank(t: Tier): number {
  return TIERS.indexOf(t);
}

/** Where a tier's model comes from, in words. */
export function sourceText(source: ModelSource | null | undefined, borrowedFrom?: Tier | null): string {
  switch (source) {
    case 'pin':
      return 'pinned by the policy';
    case 'user':
      return 'your Model tiers';
    case 'deployment':
      return 'the deployment default';
    case 'fill_down':
      return borrowedFrom ? `borrowed from ${TIER_LABEL[borrowedFrom]}` : 'borrowed from another tier';
    case 'ai_default':
      return 'your default AI model';
    default:
      return 'not set';
  }
}

/** The model a policy starts on: its pin for the start tier, else the caller's effective tier. */
export function startModel(spec: AgentPolicySpec, effective: EffectiveTiers | null): { model: string | null; source: ModelSource | null } {
  const tier = spec.models.startTier;
  const pin = spec.models.pins?.[tier];
  if (pin) return { model: pin, source: 'pin' };
  const e: EffectiveTier | undefined = effective?.[tier];
  return { model: e?.model ?? null, source: e?.modelSource ?? null };
}

/** The policy a task runs under, and the model its start tier uses, as the task chips show them. */
export function taskPolicyChips(task: Pick<Task, 'policyId'>, catalog: Pick<PolicyCatalog, 'byId' | 'defaultId' | 'effective'>): { policy: string; model: string | null } | null {
  const policy = catalog.byId(task.policyId ?? catalog.defaultId);
  if (!policy) return null;
  const { model } = startModel(policy.spec, catalog.effective);
  return { policy: task.policyId ? policy.name : `${policy.name} (default)`, model };
}

/** The value a run actually gets: `min(policy, ceiling)`; null only when both are unlimited. */
export function clampToCeiling(value: number | null, ceiling: number | null | undefined): number | null {
  if (ceiling === null || ceiling === undefined) return value;
  if (value === null) return ceiling;
  return Math.min(value, ceiling);
}

/** The helper line a ceiling adds under a budget field, or null when there is none. */
export function ceilingText(key: BudgetLimitKey, value: number | null, ceilings: BudgetCeilings | null): string | null {
  const ceiling = ceilings?.[key];
  if (ceiling === null || ceiling === undefined) return null;
  const capped = `Capped at ${budgetPhrase(key, ceiling)} by your administrator`;
  if (value === null || value > ceiling) return `${capped}: runs get ${budgetPhrase(key, ceiling)}.`;
  return `${capped}.`;
}

/** A fresh name for a copy: "Name (copy)", "Name (copy 2)"... among `taken`. */
export function copyName(name: string, taken: readonly string[]): string {
  const base = `${name} (copy)`.slice(0, 100);
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 100; n++) {
    const next = `${name} (copy ${n})`.slice(0, 100);
    if (!taken.includes(next)) return next;
  }
  return base;
}

/** Built-ins first (in the API's order), then own policies by name. */
export function sortPolicies(policies: readonly AgentPolicy[]): AgentPolicy[] {
  const builtins = policies.filter((p) => p.builtin);
  const own = policies.filter((p) => !p.builtin).sort((a, b) => a.name.localeCompare(b.name));
  return [...builtins, ...own];
}
