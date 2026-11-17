import type { AgentPolicySpec, Tier } from './agent-policy.schema';
import { agentPolicySpecSchema } from './agent-policy.schema';
import { builtinPolicy } from './builtin-policies';
import { readEffectiveBudget, runBudgetView, type BudgetRunColumns, type EffectiveBudget, type RunBudgetView } from '../runner/budget';
import type { ResolvedTiers } from './model-tiers.schema';
import { runTierView, type RunTierColumns, type RunTierView } from './run-tier-view';

/** Why a policy applied to a run (`runs.policy_source`). */
export const POLICY_SOURCES = ['run', 'schedule', 'task', 'user_default', 'system_default'] as const;
export type PolicySource = (typeof POLICY_SOURCES)[number];

/**
 * What a run keeps of the policy it runs under (`runs.policy_snapshot`). Written
 * once, at the run's first `advance`, and never changed: editing a policy or the
 * user's settings later never changes a live run. The runner and the budget
 * engine read only this, never the policy row.
 */
export interface RunPolicySnapshot {
  schemaVersion: 1;
  /** An own policy's UUID or `builtin:<key>`. */
  ref: string;
  name: string;
  version: number;
  builtin: boolean;
  source: PolicySource;
  /** The full spec as it was at the start of the run. */
  spec: AgentPolicySpec;
  /** The resolved tier to model map; null until the tier resolver fills it (E31.5). */
  tiers: Partial<Record<Tier, { provider: string | null; model: string | null }>> | null;
  /**
   * The three tiers as resolved at the start of the run (#403): model, provider, effort, output cap,
   * fallback and capability flags. Every model call reads its model from here, never from the
   * settings, so editing the tiers mid-run never changes a live run. Absent on a run snapshotted before #403.
   */
  resolvedTiers?: ResolvedTiers | null;
  /** ISO time the snapshot was taken. */
  takenAt: string;
  /**
   * The limits the run is held to: the policy's budget clamped by the deployment's
   * ceilings (#404), written at the run's first advance. Absent on a snapshot taken before that.
   */
  effectiveBudget?: EffectiveBudget;
}

/** Parse a stored snapshot; null when it is absent or no longer valid. */
export function readSnapshot(value: unknown): RunPolicySnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<RunPolicySnapshot>;
  const spec = agentPolicySpecSchema.safeParse(v.spec);
  if (!spec.success || typeof v.ref !== 'string' || typeof v.name !== 'string' || typeof v.version !== 'number') return null;
  const effectiveBudget = readEffectiveBudget(v.effectiveBudget);
  const { effectiveBudget: _raw, ...rest } = v as RunPolicySnapshot;
  return { ...rest, spec: spec.data, builtin: v.builtin ?? builtinPolicy(v.ref) !== undefined, ...(effectiveBudget ? { effectiveBudget } : {}) };
}

/** The run's policy summary, as the run responses show it. */
export interface RunPolicySummary {
  id: string;
  name: string;
  version: number;
  source: PolicySource;
  builtin: boolean;
}

export function summarize(snapshot: RunPolicySnapshot | null): RunPolicySummary | null {
  return snapshot ? { id: snapshot.ref, name: snapshot.name, version: snapshot.version, source: snapshot.source, builtin: snapshot.builtin } : null;
}

/** The raw policy columns of a run row. */
interface RunPolicyColumns extends Partial<BudgetRunColumns>, RunTierColumns {
  policyRef?: unknown;
  policyVersion?: unknown;
  policySnapshot?: unknown;
  policySource?: unknown;
}

/**
 * A run row as the API returns it: the raw policy columns replaced by
 * `policy: { id, name, version, source, builtin }` (null until the run's first
 * advance has snapshotted it) and `budget: { effective, used, percent, source }`
 * (null until then too, and for a snapshot taken before budgets were enforced)
 * and `tier: { start, max, current, escalations, model }` (#408, null until then).
 * `stopReason` is a column and passes through.
 */
export function runView<R extends RunPolicyColumns>(run: R): Omit<R, 'policyRef' | 'policyVersion' | 'policySnapshot' | 'policySource'> & { policy: RunPolicySummary | null; budget: RunBudgetView | null; tier: RunTierView | null } {
  const { policyRef: _r, policyVersion: _v, policySnapshot, policySource: _s, ...rest } = run;
  const snapshot = readSnapshot(policySnapshot);
  return { ...rest, policy: summarize(snapshot), budget: snapshotBudgetView(snapshot, run), tier: runTierView(snapshot, run) };
}

/** The budget view of a run under its snapshot; null without an effective budget or the run's totals. */
export function snapshotBudgetView(snapshot: RunPolicySnapshot | null, run: Partial<BudgetRunColumns>, nowMs = Date.now()): RunBudgetView | null {
  if (!snapshot?.effectiveBudget) return null;
  if (run.stepCount === undefined || run.modelCalls === undefined || run.inputTokens === undefined || run.outputTokens === undefined || run.costUsd === undefined || run.costKnown === undefined || run.activeMs === undefined) return null;
  return runBudgetView(snapshot.effectiveBudget, { ...(run as BudgetRunColumns), activeSince: run.activeSince ?? null }, nowMs);
}
