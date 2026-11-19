import type { AgentPolicySpec, Tier } from './agent-policy.schema';
import { maskRunGoal, runInputsView } from '../tasks/task-params';
import { outputsView } from '../tasks/task-outputs';
import type { OutputView } from '../tasks/task-outputs.schemas';
import { agentPolicySpecSchema } from './agent-policy.schema';
import { builtinPolicy } from './builtin-policies';
import { readConfirmedActions } from '../runner/confirmed-actions';
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
  /**
   * The limits of the AI app that started the run (#464), as they were when it
   * started: its allowed sites (checked as well as the task's own) and whether
   * risky steps need a person. Absent on a run no app started.
   */
  appLimits?: SnapshotAppLimits | null;
}

/** What a snapshot keeps of an app's limits (`RunAppLimits` of connected-apps.schemas.ts). */
export interface SnapshotAppLimits {
  clientId: string;
  clientName: string | null;
  allowedDomains: string[];
  confirmPurchases: boolean;
  /** The owner allowed this app's runs to sign in from saved logins (E37.3); false when absent. */
  allowSavedLogins: boolean;
  /** The owner allowed this app's runs to fill identity details (E37.6); false when absent. */
  allowSavedIdentity: boolean;
  /** The owner allowed this app's runs to pay with a saved card (E37.7); false when absent. */
  allowSavedCards: boolean;
  policyId: string | null;
  allowedPolicyIds: string[];
  appliedPolicyId: string | null;
  maxConcurrentRuns: number;
  dailyRunLimit: number;
  dailyCostLimitUsd: number | null;
}

/** An app's limits as stored on a run (`runs.app_limits`); null when absent or unreadable. */
export function readAppLimits(value: unknown): SnapshotAppLimits | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<SnapshotAppLimits>;
  if (typeof v.clientId !== 'string' || !Array.isArray(v.allowedDomains)) return null;
  return {
    clientId: v.clientId,
    clientName: typeof v.clientName === 'string' ? v.clientName : null,
    allowedDomains: v.allowedDomains.filter((d): d is string => typeof d === 'string'),
    confirmPurchases: v.confirmPurchases !== false,
    allowSavedLogins: v.allowSavedLogins === true,
    allowSavedIdentity: v.allowSavedIdentity === true,
    allowSavedCards: v.allowSavedCards === true,
    policyId: typeof v.policyId === 'string' ? v.policyId : null,
    allowedPolicyIds: Array.isArray(v.allowedPolicyIds) ? v.allowedPolicyIds.filter((d): d is string => typeof d === 'string') : [],
    appliedPolicyId: typeof v.appliedPolicyId === 'string' ? v.appliedPolicyId : null,
    maxConcurrentRuns: typeof v.maxConcurrentRuns === 'number' ? v.maxConcurrentRuns : 0,
    dailyRunLimit: typeof v.dailyRunLimit === 'number' ? v.dailyRunLimit : 0,
    dailyCostLimitUsd: typeof v.dailyCostLimitUsd === 'number' ? v.dailyCostLimitUsd : null,
  };
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
export function runView<R extends RunPolicyColumns>(run: R): Omit<R, 'policyRef' | 'policyVersion' | 'policySnapshot' | 'policySource' | 'outputs' | 'outputsSpec'> & { outputs?: OutputView[] | null; policy: RunPolicySummary | null; budget: RunBudgetView | null; tier: RunTierView | null } {
  const { policyRef: _r, policyVersion: _v, policySnapshot, policySource: _s, outputsSpec, outputs, ...rest } = run as R & { outputsSpec?: unknown; outputs?: unknown };
  const snapshot = readSnapshot(policySnapshot);
  // A full run carries its confirmed steps as a list (#540), never null; a list row's count passes through.
  const confirmed = 'confirmedActions' in rest && typeof (rest as { confirmedActions?: unknown }).confirmedActions !== 'number' ? { confirmedActions: readConfirmedActions((rest as { confirmedActions?: unknown }).confirmedActions) } : {};
  // The goal and the task parameter values as a person reads them: each inserted value masked (#552, #538).
  const shown = {
    ...('goal' in rest && typeof (rest as { goal?: unknown }).goal === 'string' ? { goal: maskRunGoal((rest as { goal: string }).goal) } : {}),
    ...('inputs' in rest ? { inputs: runInputsView((rest as { inputs?: unknown }).inputs) } : {}),
    // What the run returned (E39.5): the definitions it started with joined with the values, a sensitive one hidden. A row without the columns (a list) has none.
    ...(outputs !== undefined || outputsSpec !== undefined ? { outputs: outputsView(outputsSpec, outputs) } : {}),
  };
  return { ...rest, ...confirmed, ...shown, policy: summarize(snapshot), budget: snapshotBudgetView(snapshot, run), tier: runTierView(snapshot, run) };
}

/** The budget view of a run under its snapshot; null without an effective budget or the run's totals. */
export function snapshotBudgetView(snapshot: RunPolicySnapshot | null, run: Partial<BudgetRunColumns>, nowMs = Date.now()): RunBudgetView | null {
  if (!snapshot?.effectiveBudget) return null;
  if (run.stepCount === undefined || run.modelCalls === undefined || run.inputTokens === undefined || run.outputTokens === undefined || run.costUsd === undefined || run.costKnown === undefined || run.activeMs === undefined) return null;
  return runBudgetView(snapshot.effectiveBudget, { ...(run as BudgetRunColumns), activeSince: run.activeSince ?? null }, nowMs);
}
