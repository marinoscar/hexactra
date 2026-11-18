/**
 * How a run's spend reads on its page (#408): the budget meter's rows, the
 * header chips (policy, tier, model), the stop-reason line and the cost
 * figures. Pure: the API computes every number; this only formats them.
 */

/** The six budgets, in the order the API reports them. */
export const BUDGET_KEYS = ['actions', 'modelCalls', 'activeMinutes', 'inputTokens', 'outputTokens', 'cost'] as const;
export type BudgetKey = (typeof BUDGET_KEYS)[number];

/** `budget` on a run and on each streamed `run` event (#404). */
export interface RunBudget {
  /** The limits (null: unlimited), plus the warning threshold. Active time in minutes, cost in USD. */
  effective: Record<BudgetKey, number | null> & { warnAtPercent: number };
  used: Record<BudgetKey, number>;
  percent: Record<BudgetKey, number | null>;
  source: Record<BudgetKey, 'policy' | 'ceiling' | null>;
  /** False when a call could not be priced: `used.cost` is "at least". */
  costKnown: boolean;
  /** `soft`: a chat run, whose limits are shown and never enforced (#537). Absent (hard) on older responses. */
  enforcement?: 'hard' | 'soft';
  /** The budgets at or over their limit, in check order. */
  over?: BudgetKey[];
}

export type Tier = 'fast' | 'standard' | 'frontier';

/** `tier` on a run (#408). */
export interface RunTier {
  start: Tier;
  max: Tier;
  current: Tier;
  escalations: number;
  model: string | null;
}

export type PolicySource = 'run' | 'schedule' | 'task' | 'user_default' | 'system_default';

/** `policy` on a run (#401). */
export interface RunPolicy {
  id: string;
  name: string;
  version: number;
  source: PolicySource;
  builtin: boolean;
}

/** `stopReason` on a run (#404). */
export type StopReason =
  | 'finished'
  | 'budget_actions'
  | 'budget_model_calls'
  | 'budget_active_time'
  | 'budget_input_tokens'
  | 'budget_output_tokens'
  | 'budget_cost'
  | 'stalled'
  | 'cancelled'
  | 'error'
  | 'no_model';

export const STOP_REASONS: readonly StopReason[] = ['finished', 'budget_actions', 'budget_model_calls', 'budget_active_time', 'budget_input_tokens', 'budget_output_tokens', 'budget_cost', 'stalled', 'cancelled', 'error', 'no_model'];

export const BUDGET_LABEL: Record<BudgetKey, string> = {
  actions: 'Actions',
  modelCalls: 'Model calls',
  activeMinutes: 'Active time',
  inputTokens: 'Input tokens',
  outputTokens: 'Output tokens',
  cost: 'Cost',
};

/** The budget a `budget_*` stop reason names. */
export const STOP_REASON_BUDGET: Partial<Record<StopReason, BudgetKey>> = {
  budget_actions: 'actions',
  budget_model_calls: 'modelCalls',
  budget_active_time: 'activeMinutes',
  budget_input_tokens: 'inputTokens',
  budget_output_tokens: 'outputTokens',
  budget_cost: 'cost',
};

export const TIER_LABEL: Record<Tier, string> = { fast: 'Fast', standard: 'Standard', frontier: 'Frontier' };

/** How the policy chip names why the policy applied. */
export const POLICY_SOURCE_LABEL: Record<PolicySource, string> = {
  run: 'this run',
  schedule: 'schedule',
  task: 'task',
  user_default: 'default',
  system_default: 'default',
};

/** "$2.40"; amounts under a cent keep 4 decimals ("$0.0042"); "≥ $2.40" when part could not be priced. */
export function formatUsd(amount: number, known = true): string {
  const n = Number.isFinite(amount) ? amount : 0;
  const text = n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
  return known ? text : `≥ ${text}`;
}

/** A run's cost as text, or null before it made a model call. */
export function runCost(r: { costUsd?: number | null; costKnown?: boolean; modelCalls?: number }): string | null {
  return typeof r.costUsd === 'number' && (r.modelCalls ?? 0) > 0 ? formatUsd(r.costUsd, r.costKnown ?? true) : null;
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** A budget amount in its unit: "12", "3.5 min", "1.2M", "$0.42". */
export function formatBudget(key: BudgetKey, n: number, costKnown = true): string {
  switch (key) {
    case 'cost':
      return formatUsd(n, costKnown);
    case 'activeMinutes':
      return n < 10 ? `${Math.floor(n * 10) / 10} min` : `${Math.floor(n)} min`;
    case 'inputTokens':
    case 'outputTokens':
      return n >= 10_000 ? compact.format(n) : Math.round(n).toLocaleString('en');
    default:
      return String(Math.round(n));
  }
}

/** `over`: a soft budget (a chat run, #537) past its limit: the bar is full and the run keeps working. */
export type MeterTone = 'primary' | 'warning' | 'error' | 'over';

/** The palette colour of a tone (`over` reads as a warning, never as an error: nothing stopped). */
export function toneColor(tone: MeterTone): 'primary' | 'warning' | 'error' {
  return tone === 'over' ? 'warning' : tone;
}

/** The caption under the meter of a soft budget. */
export const SOFT_BUDGET_CAPTION = 'Limits are shown for reference. A chat run is not stopped by them.';

/** One bar of the meter. */
export interface MeterRow {
  key: BudgetKey;
  label: string;
  used: number;
  /** null: unlimited (no bar, an "∞"). */
  limit: number | null;
  /** Percent of the limit used (may pass 100); null when unlimited. */
  percent: number | null;
  tone: MeterTone;
  /** "12 / 60", "≥ $0.42 / $2.00", or "12 used" when unlimited. */
  text: string;
  /** Set when a deployment ceiling, not the policy, set the limit. */
  ceiling: boolean;
}

/** Warning from `warnAtPercent`, error at 100% (`over` for a soft budget, which keeps working). */
export function meterTone(percent: number | null, warnAtPercent: number, soft = false): MeterTone {
  if (percent === null) return 'primary';
  if (percent >= 100) return soft ? 'over' : 'error';
  if (percent >= warnAtPercent) return 'warning';
  return 'primary';
}

/**
 * The meter's rows. `extraActiveMinutes` is the time since the budget was
 * received, for a running run, so active time ticks between stream events.
 */
export function meterRows(budget: RunBudget, extraActiveMinutes = 0): MeterRow[] {
  return BUDGET_KEYS.map((key) => {
    const limit = budget.effective[key];
    const used = (budget.used[key] ?? 0) + (key === 'activeMinutes' ? Math.max(0, extraActiveMinutes) : 0);
    const percent = limit === null ? null : limit > 0 ? Math.round((used / limit) * 1000) / 10 : 100;
    const known = key === 'cost' ? budget.costKnown : true;
    const text = limit === null ? `${formatBudget(key, used, known)} used` : `${formatBudget(key, used, known)} / ${formatBudget(key, limit)}`;
    return { key, label: BUDGET_LABEL[key], used, limit, percent, tone: meterTone(percent, budget.effective.warnAtPercent, budget.enforcement === 'soft'), text, ceiling: budget.source[key] === 'ceiling' };
  });
}

/** "64 of 60 actions", "$2.10 of $2.00", "21 min of 20 min of active time": a budget's use in words. */
export function usedOfLimitText(key: BudgetKey, used: number, limit: number, costKnown = true): string {
  const figures = `${formatBudget(key, used, key === 'cost' ? costKnown : true)} of ${formatBudget(key, limit)}`;
  switch (key) {
    case 'cost':
      return figures;
    case 'activeMinutes':
      return `${figures} of active time`;
    default:
      return `${figures} ${BUDGET_LABEL[key].toLowerCase()}`;
  }
}

/** The budget closest to its limit, or furthest over it; null when none is limited. */
export function closestBudget(budget: RunBudget): { key: BudgetKey; percent: number; used: number; limit: number } | null {
  let best: { key: BudgetKey; percent: number; used: number; limit: number } | null = null;
  for (const key of BUDGET_KEYS) {
    const limit = budget.effective[key];
    const percent = budget.percent[key];
    if (limit === null || percent === null) continue;
    if (!best || percent > best.percent) best = { key, percent, used: budget.used[key] ?? 0, limit };
  }
  return best;
}

/** The chat card's line about a soft budget (#537): near the limit, or over it and still working; null otherwise. */
export function softBudgetNotice(budget: RunBudget | null | undefined): { tone: 'near' | 'over'; text: string } | null {
  if (!budget || budget.enforcement !== 'soft') return null;
  const top = closestBudget(budget);
  if (!top) return null;
  const words = usedOfLimitText(top.key, top.used, top.limit, budget.costKnown);
  if (top.percent >= 100) return { tone: 'over', text: `Over the usual limit: ${words}. Still working. Press Stop to end it.` };
  if (top.percent >= budget.effective.warnAtPercent) return { tone: 'near', text: `Close to this chat's usual limit: ${words}.` };
  return null;
}

/** The plain line of a finished run that went over a soft limit without being stopped by it (#537); null otherwise. */
export function overLimitLine(run: StopReasonRun): string | null {
  const b = run.budget;
  if (!b || b.enforcement !== 'soft' || !b.over?.length) return null;
  if (run.stopReason && STOP_REASON_BUDGET[run.stopReason]) return null;
  const top = closestBudget(b);
  return top && top.percent >= 100 ? `Went over its usual limit: ${usedOfLimitText(top.key, top.used, top.limit, b.costKnown)}.` : null;
}

/** "policy: Balanced v3 · default". */
export function policyChipLabel(p: RunPolicy): string {
  return `policy: ${p.name} v${p.version} · ${POLICY_SOURCE_LABEL[p.source] ?? p.source}`;
}

/** "tier: Standard", or "tier: Standard → Frontier" once the run escalated (`escalated` true). */
export function tierChip(t: RunTier): { label: string; escalated: boolean } {
  const escalated = t.current !== t.start;
  return { label: escalated ? `tier: ${TIER_LABEL[t.start]} → ${TIER_LABEL[t.current]}` : `tier: ${TIER_LABEL[t.current]}`, escalated };
}

/** The fields of a run the stop line reads. */
export interface StopReasonRun {
  status: string;
  stopReason?: StopReason | null;
  result: string | null;
  error: string | null;
  budget?: RunBudget | null;
}

/** How a stall stop reads everywhere: the run page's line, the status chip (`STOP_REASON_LABEL.stalled`) and the task page. */
export const STALLED_LABEL = 'stalled';

export interface StopLine {
  severity: 'success' | 'info' | 'warning' | 'error';
  /** "Stopped: cost budget reached ($2.00)." */
  title: string;
  /** "The agent's summary: …", when the run kept one. */
  summary: string | null;
  /** The error text, when it adds something to the title. */
  detail: string | null;
}

/** The line a terminal run shows about why it stopped; null while it runs or when the API gives no reason (older runs). */
export function stopLine(run: StopReasonRun): StopLine | null {
  const reason = run.stopReason;
  if (!reason) return null;
  const summary = run.result ? `The agent's summary: ${run.result}` : null;
  const budgetKey = STOP_REASON_BUDGET[reason];
  if (budgetKey) {
    const limit = run.budget?.effective[budgetKey];
    const what = `${BUDGET_LABEL[budgetKey].toLowerCase()} budget`;
    const title = `Stopped: ${what} reached${typeof limit === 'number' ? ` (${formatBudget(budgetKey, limit)})` : ''}.`;
    return { severity: run.status === 'succeeded' ? 'success' : 'warning', title, summary, detail: null };
  }
  switch (reason) {
    case 'finished':
      return run.status === 'succeeded'
        ? { severity: 'success', title: 'Finished: the agent completed the goal.', summary, detail: null }
        : { severity: 'info', title: 'Finished: the agent ended the run without completing the goal.', summary, detail: null };
    case 'stalled':
      // #405 records the stall as "The agent stalled: <reason>"; the title already says so.
      // The word is the kit's (`STOP_REASON_LABEL.stalled`), so the run page, the runs list's chip and the task page agree.
      const why = run.error?.replace(/^The agent stalled:\s*/i, '');
      return { severity: 'warning', title: `Stopped: ${STALLED_LABEL}${why ? ` (${why})` : ''}.`, summary, detail: null };
    case 'cancelled':
      return { severity: 'info', title: 'Stopped: cancelled.', summary, detail: null };
    case 'no_model':
      return { severity: 'error', title: "Stopped: no usable model for this run's tier.", summary, detail: run.error };
    case 'error':
    default:
      return { severity: 'error', title: 'Stopped: an error ended the run.', summary, detail: run.error };
  }
}

/** What a task spent over the last 30 days (`spend30d`). */
export interface TaskSpend {
  runs: number;
  costUsd: number;
  costKnown: boolean;
  tokens: number;
  succeeded?: number;
  avgSuccessCostUsd?: number | null;
}

/** "Last 30 days: 4 runs · $1.20 · 120k tokens · $0.40 per successful run". */
export function spendLine(s: TaskSpend): string {
  if (s.runs === 0) return 'Last 30 days: no runs';
  const parts = [`${s.runs} run${s.runs === 1 ? '' : 's'}`, formatUsd(s.costUsd, s.costKnown), `${formatBudget('inputTokens', s.tokens)} tokens`];
  if (typeof s.avgSuccessCostUsd === 'number') parts.push(`${formatUsd(s.avgSuccessCostUsd, s.costKnown)} per successful run`);
  else if (s.succeeded === 0) parts.push('no successful run');
  return `Last 30 days: ${parts.join(' · ')}`;
}
