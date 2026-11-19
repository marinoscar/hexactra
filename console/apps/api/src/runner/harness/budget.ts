// The budget engine (#404): pure, no I/O, no clock.
//
// A run has up to six budgets (actions, model calls, active minutes, input
// tokens, output tokens, cost). Each is a limit or `null` (unlimited). The
// limit the run is held to is the policy's, clamped by the deployment's
// ceiling (`browserAgentCeilings`): `min(policy ?? inf, ceiling ?? inf)`. It
// is computed once, at the run's first advance, and stored on the run's
// policy snapshot (`effectiveBudget`), so a later edit of the policy or of a
// ceiling never changes a live run.
//
// `BudgetTracker` adds up what the run uses and says which budget is
// exhausted and which should be warned about. It starts from what the run
// already used in earlier jobs and chunks (the totals on the run row), so a
// run continued after a handoff or a job hop never gets a fresh budget.

/** The budget part of an agent policy: a limit per budget (`null` is unlimited) and the warning threshold. */
export interface BudgetSpec {
  maxActions: number | null;
  maxModelCalls: number | null;
  maxActiveMinutes: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  maxCostUsd: number | null;
  warnAtPercent: number;
}

/** The six budgets, in the order they are checked and reported. */
export const BUDGET_KEYS = ['actions', 'modelCalls', 'activeMinutes', 'inputTokens', 'outputTokens', 'cost'] as const;
export type BudgetKey = (typeof BUDGET_KEYS)[number];

/** The policy `budget` field that holds each budget's limit (also the ceiling's field). */
export const BUDGET_LIMIT_FIELD = {
  actions: 'maxActions',
  modelCalls: 'maxModelCalls',
  activeMinutes: 'maxActiveMinutes',
  inputTokens: 'maxInputTokens',
  outputTokens: 'maxOutputTokens',
  cost: 'maxCostUsd',
} as const satisfies Record<BudgetKey, keyof BudgetSpec>;
export type BudgetLimitField = (typeof BUDGET_LIMIT_FIELD)[BudgetKey];

/** Why a run stopped (`runs.stop_reason`), as the database enum spells it. */
export const RUN_STOP_REASONS = [
  'finished',
  'budget_actions',
  'budget_model_calls',
  'budget_active_time',
  'budget_input_tokens',
  'budget_output_tokens',
  'budget_cost',
  'stalled',
  'cancelled',
  'error',
  'no_model',
] as const;
export type RunStopReason = (typeof RUN_STOP_REASONS)[number];

/** The stop reason a budget produces. */
export const BUDGET_STOP_REASON = {
  actions: 'budget_actions',
  modelCalls: 'budget_model_calls',
  activeMinutes: 'budget_active_time',
  inputTokens: 'budget_input_tokens',
  outputTokens: 'budget_output_tokens',
  cost: 'budget_cost',
} as const satisfies Record<BudgetKey, RunStopReason>;

/** Every budget stop reason (what the alerts count). */
export const BUDGET_STOP_REASONS: readonly RunStopReason[] = Object.values(BUDGET_STOP_REASON);

/** What a budget is called in the text the model reads. */
export const BUDGET_LABEL: Record<BudgetKey, string> = {
  actions: 'actions',
  modelCalls: 'model calls',
  activeMinutes: 'active time',
  inputTokens: 'input tokens',
  outputTokens: 'output tokens',
  cost: 'cost',
};

/** What the deployment's admin ceilings hold: the policy budget's limit fields, each nullable. */
export type BudgetCeilings = Partial<Record<BudgetLimitField, number | null>>;

/** Where an effective limit came from: the policy, or the ceiling that clamped it. `null`: unlimited. */
export type BudgetSource = 'policy' | 'ceiling' | null;

/**
 * How a run's limits apply (#537). `hard`: a used-up budget ends the run.
 * `soft`: the run is interactive (a chat started it, the owner is present and
 * can press Stop), so every limit is counted, shown and warned about, never
 * enforced.
 */
export type BudgetEnforcement = 'hard' | 'soft';

/** The limits a run is held to, written onto its policy snapshot at the first advance. */
export interface EffectiveBudget {
  /** Per budget; `null` is unlimited. Active time is in minutes, cost in USD. */
  limits: Record<BudgetKey, number | null>;
  source: Record<BudgetKey, BudgetSource>;
  warnAtPercent: number;
  /** Absent on snapshots written before #537: read as `hard`. */
  enforcement: BudgetEnforcement;
}

/** A chat run is interactive: its budgets are soft (#537). Every other trigger keeps hard budgets. */
export function enforcementFor(trigger: string | null | undefined): BudgetEnforcement {
  return trigger === 'chat' ? 'soft' : 'hard';
}

/** `min(policy ?? inf, ceiling ?? inf)`: unlimited only when both are null. A tie names the policy. */
export function clampLimit(policy: number | null | undefined, ceiling: number | null | undefined): { limit: number | null; source: BudgetSource } {
  const p = policy ?? null;
  const c = ceiling ?? null;
  if (p === null && c === null) return { limit: null, source: null };
  if (c === null) return { limit: p, source: 'policy' };
  if (p === null || c < p) return { limit: c, source: 'ceiling' };
  return { limit: p, source: 'policy' };
}

/** The effective budget of a policy under the deployment's ceilings. */
export function computeEffectiveBudget(budget: BudgetSpec, ceilings: BudgetCeilings | null | undefined, enforcement: BudgetEnforcement = 'hard'): EffectiveBudget {
  const limits = {} as Record<BudgetKey, number | null>;
  const source = {} as Record<BudgetKey, BudgetSource>;
  for (const k of BUDGET_KEYS) {
    const field = BUDGET_LIMIT_FIELD[k];
    const r = clampLimit(budget[field], ceilings?.[field]);
    limits[k] = r.limit;
    source[k] = r.source;
  }
  return { limits, source, warnAtPercent: budget.warnAtPercent, enforcement };
}

/** True when no budget has a limit: only finishing, a stop or a stall ends the run. */
export function isUnlimited(effective: EffectiveBudget): boolean {
  return BUDGET_KEYS.every((k) => effective.limits[k] === null);
}

/** Read a stored `effectiveBudget`; null when it is absent or malformed. */
export function readEffectiveBudget(value: unknown): EffectiveBudget | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<EffectiveBudget>;
  if (!v.limits || typeof v.limits !== 'object' || typeof v.warnAtPercent !== 'number') return null;
  const limits = {} as Record<BudgetKey, number | null>;
  const source = {} as Record<BudgetKey, BudgetSource>;
  for (const k of BUDGET_KEYS) {
    const l = (v.limits as Record<string, unknown>)[k];
    if (l !== null && typeof l !== 'number') return null;
    limits[k] = l ?? null;
    const s = (v.source as Record<string, unknown> | undefined)?.[k];
    source[k] = s === 'policy' || s === 'ceiling' ? s : l === null ? null : 'policy';
  }
  return { limits, source, warnAtPercent: v.warnAtPercent, enforcement: v.enforcement === 'soft' ? 'soft' : 'hard' };
}

/** What a run has used, by budget (active time in minutes, cost in USD). */
export type BudgetUsed = Record<BudgetKey, number>;

/** What `add` takes: increments. Anything absent is zero. */
export interface BudgetDelta {
  actions?: number;
  modelCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** USD of the priced calls. */
  costUsd?: number;
  /** False when a call in this delta could not be priced: the cost is then a lower bound. */
  costKnown?: boolean;
  activeMs?: number;
}

/** The totals a tracker starts from (the run row). */
export interface BudgetTotals extends BudgetDelta {
  /** Budgets already warned about (kept in the run's memory across jobs). */
  warned?: readonly BudgetKey[];
  /** Budgets already noticed as over their limit (soft budgets, #537; kept in the run's memory across jobs). */
  overNoticed?: readonly BudgetKey[];
}

export interface BudgetState {
  /** The first exhausted budget in `BUDGET_KEYS` order, or null. Always null under `soft` enforcement: the single switch (#537). */
  exhausted: BudgetKey | null;
  /** Every budget with `used >= limit`, in `BUDGET_KEYS` order (under either enforcement). */
  over: BudgetKey[];
  /** Budgets at or over `warnAtPercent` (and not exhausted) that have not been warned about yet. */
  warn: BudgetKey[];
  /** Percent of each limit used; `null` for an unlimited budget. */
  percent: Record<BudgetKey, number | null>;
}

const MICROS = 1_000_000;

function amount(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Adds up a run's usage against its effective budget.
 *
 * A budget is exhausted once `used >= limit`. An unknown cost (a call on a
 * model with no price) adds nothing to the cost but flags the tracker
 * (`costKnown = false`): the known part counts toward `maxCostUsd` and the
 * UI shows "at least".
 */
export class BudgetTracker {
  private actions: number;
  private modelCalls: number;
  private inputTokens: number;
  private outputTokens: number;
  private costMicros: number;
  private activeMs: number;
  private known: boolean;
  private readonly warned: Set<BudgetKey>;
  private readonly overNoticed: Set<BudgetKey>;

  constructor(
    private readonly effective: EffectiveBudget,
    starting: BudgetTotals = {},
  ) {
    this.actions = amount(starting.actions);
    this.modelCalls = amount(starting.modelCalls);
    this.inputTokens = amount(starting.inputTokens);
    this.outputTokens = amount(starting.outputTokens);
    this.costMicros = Math.round(amount(starting.costUsd) * MICROS);
    this.activeMs = amount(starting.activeMs);
    this.known = starting.costKnown ?? true;
    this.warned = new Set(starting.warned ?? []);
    this.overNoticed = new Set(starting.overNoticed ?? []);
  }

  /** How the limits apply (#537). */
  get enforcement(): BudgetEnforcement {
    return this.effective.enforcement === 'soft' ? 'soft' : 'hard';
  }

  add(delta: BudgetDelta): void {
    this.actions += amount(delta.actions);
    this.modelCalls += amount(delta.modelCalls);
    this.inputTokens += amount(delta.inputTokens);
    this.outputTokens += amount(delta.outputTokens);
    this.costMicros += Math.round(amount(delta.costUsd) * MICROS);
    this.activeMs += amount(delta.activeMs);
    if (delta.costKnown === false) this.known = false;
  }

  /** Set the active time to the run's current total (the caller derives it from the active clock). Never goes down. */
  setActiveMs(totalMs: number): void {
    this.activeMs = Math.max(this.activeMs, amount(totalMs));
  }

  /** False once any call could not be priced: `used.cost` is then a lower bound. */
  get costKnown(): boolean {
    return this.known;
  }

  used(): BudgetUsed {
    return {
      actions: this.actions,
      modelCalls: this.modelCalls,
      activeMinutes: this.activeMs / 60_000,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cost: this.costMicros / MICROS,
    };
  }

  /** Where the run stands. Pure: it does not mark warnings as given (see `takeWarnings`). */
  state(): BudgetState {
    const used = this.used();
    const percent = {} as Record<BudgetKey, number | null>;
    const over: BudgetKey[] = [];
    const warn: BudgetKey[] = [];
    for (const k of BUDGET_KEYS) {
      const limit = this.effective.limits[k];
      if (limit === null) {
        percent[k] = null;
        continue;
      }
      percent[k] = (used[k] / limit) * 100;
      if (used[k] >= limit) {
        over.push(k);
      } else if (percent[k]! >= this.effective.warnAtPercent && !this.warned.has(k)) {
        warn.push(k);
      }
    }
    const exhausted = this.enforcement === 'soft' ? null : (over[0] ?? null);
    return { exhausted, over, warn, percent };
  }

  /** The budgets newly over the warning threshold, each returned once, ever (across jobs when `warnedKeys` is stored). */
  takeWarnings(): BudgetKey[] {
    const { warn } = this.state();
    for (const k of warn) this.warned.add(k);
    return warn;
  }

  /** Every budget warned about so far, to keep in the run's memory. */
  warnedKeys(): BudgetKey[] {
    return BUDGET_KEYS.filter((k) => this.warned.has(k));
  }

  /** The budgets newly over their limit, each returned once, ever (across jobs when `overNoticedKeys` is stored). */
  takeOverNotices(): BudgetKey[] {
    const fresh = this.state().over.filter((k) => !this.overNoticed.has(k));
    for (const k of fresh) this.overNoticed.add(k);
    return fresh;
  }

  /** Every budget noticed as over its limit so far, to keep in the run's memory. */
  overNoticedKeys(): BudgetKey[] {
    return BUDGET_KEYS.filter((k) => this.overNoticed.has(k));
  }
}

function fmt(key: BudgetKey, n: number): string {
  switch (key) {
    case 'cost':
      return `$${n.toFixed(2)}`;
    case 'activeMinutes':
      return `${Math.round(n * 10) / 10} min`;
    default:
      return String(Math.round(n));
  }
}

/** `<used> of <limit>`, in the budget's own unit. */
export function usedOfLimit(key: BudgetKey, used: number, limit: number): string {
  return `${fmt(key, used)} of ${fmt(key, limit)}`;
}

/** The line the model reads in the round after a budget crossed `warnAtPercent`. */
export function warningLine(key: BudgetKey, percent: number, used: number, limit: number): string {
  return `Budget: ${BUDGET_LABEL[key]} is at ${Math.floor(percent)}% (${usedOfLimit(key, used, limit)}). Finish the goal now if you can; otherwise call finish with what you achieved and what remains.`;
}

/** The instruction of the final, exempt call after a budget is used up. */
export function wrapUpInstruction(key: BudgetKey): string {
  return `The ${BUDGET_LABEL[key]} budget is used up. Call finish now: success only if the goal is fully done; otherwise summarise exactly what was done and what remains.`;
}

/** The neutral line a soft-budget run's log carries when a budget goes over its limit (#537): it never tells the model to hurry. */
export function overNoteLine(key: BudgetKey, used: number, limit: number): string {
  return `Budget note: ${BUDGET_LABEL[key]} is over this chat's usual limit (${usedOfLimit(key, used, limit)}). The owner is present; keep working.`;
}

/** The first line of a run log when nothing limits the run. */
export const UNLIMITED_LOG_LINE = 'Unlimited: this run stops when it finishes, is stopped, or stalls.';

/** What a run response says about the budget (`budget` on a run and on the live stream). */
export interface RunBudgetView {
  effective: Record<BudgetKey, number | null> & { warnAtPercent: number };
  used: BudgetUsed;
  /** Percent used (1 decimal); `null` for an unlimited budget. */
  percent: Record<BudgetKey, number | null>;
  source: Record<BudgetKey, BudgetSource>;
  /** False when a call could not be priced: `used.cost` is "at least". */
  costKnown: boolean;
  /** `soft`: a chat run, shown and warned about, never stopped by its limits (#537). */
  enforcement: BudgetEnforcement;
  /** The budgets at or over their limit, in `BUDGET_KEYS` order. */
  over: BudgetKey[];
}

/** The columns of a run the budget view reads. */
export interface BudgetRunColumns {
  stepCount: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | { toString(): string };
  costKnown: boolean;
  activeMs: number;
  activeSince: Date | null;
}

/** The budget view of a run, from its effective budget and its stored totals; `nowMs` closes the open active stretch. */
export function runBudgetView(effective: EffectiveBudget, run: BudgetRunColumns, nowMs: number): RunBudgetView {
  const open = run.activeSince ? Math.max(0, nowMs - run.activeSince.getTime()) : 0;
  const tracker = new BudgetTracker(effective, {
    actions: run.stepCount,
    modelCalls: run.modelCalls,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    costUsd: Number(run.costUsd),
    costKnown: run.costKnown,
    activeMs: run.activeMs + open,
  });
  const percent = {} as Record<BudgetKey, number | null>;
  const state = tracker.state();
  for (const k of BUDGET_KEYS) percent[k] = state.percent[k] === null ? null : Math.round(state.percent[k]! * 10) / 10;
  const used = tracker.used();
  used.activeMinutes = Math.round(used.activeMinutes * 100) / 100;
  return {
    effective: { ...effective.limits, warnAtPercent: effective.warnAtPercent },
    used,
    percent,
    source: effective.source,
    costKnown: tracker.costKnown,
    enforcement: tracker.enforcement,
    over: state.over,
  };
}
