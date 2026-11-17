// The console's own alert rule kinds, evaluated by the platform alerts slice
// (`@marinoscar/platform-api/alerts`) every minute: a browser host offline,
// a schedule failing, runs exceeding their budgets, runs that stall, and a
// single run that cost more than a limit (#408). Each returns one
// observation per label set; one that stops being returned counts as clear,
// so incidents resolve on their own.
//
// Kinds are plain objects registered at import time (the registry freezes at
// bootstrap), so they reach the console's services through `AlertSources`,
// which `HexactraAlertsService` fills once Nest has built them.
import { registerAlertRuleKind, type AlertObservation, type AlertRuleKind } from '@marinoscar/platform-api/alerts';
import { z } from 'zod';

/** What the kinds read. Ids are PERMANENT once rules of a kind exist. */
export interface AlertSources {
  /** `null` when no fabric connection is configured yet (nothing to watch). */
  hosts(): Promise<{ id: string; name: string; online: boolean; draining: boolean }[] | null>;
  failingSchedules(minFailures: number): Promise<{ id: string; taskName: string; consecutiveFailures: number }[]>;
  /** Per user, since `since`: tokens and USD used, and runs stopped by a budget (`stop_reason`). */
  usage(since: Date): Promise<UserUsage[]>;
  /** Per user with at least one, since `since`: runs that ended `stalled`, and the latest of them. */
  stalls(since: Date): Promise<UserStalls[]>;
  /** Runs created since `since` whose `cost_usd` is over `overUsd`, most expensive first. */
  expensiveRuns(overUsd: number, since: Date): Promise<ExpensiveRun[]>;
}

export interface UserUsage {
  userId: string;
  tokens: number;
  budgetStops: number;
  runs: number;
  /** USD of those runs; a lower bound when `costKnown` is false. Absent from a source that predates #408 (counted as 0). */
  costUsd?: number;
  costKnown?: boolean;
}

/** Which run an alert names: its id, its task's name (null for a one-off goal) and its goal (only ever shown as an excerpt). */
export interface AlertRunRef {
  runId: string;
  taskName: string | null;
  goal: string;
}

export interface UserStalls {
  userId: string;
  stalls: number;
  latest: AlertRunRef;
}

export interface ExpensiveRun extends AlertRunRef {
  userId: string;
  costUsd: number;
  costKnown: boolean;
}

/** How many characters of a goal an alert summary may carry. */
export const ALERT_GOAL_CHARS = 80;

// Secret-looking text a goal should never hold but might: "password: x",
// "token=x", "Bearer x", long key-like strings. Masked before an excerpt is
// cut, so an alert summary (and the notification and webhook built from it)
// never carries one even in its first 80 characters.
const NAMED_SECRET = /\b(pass(?:word|wd|phrase|code)?|pwd|otp|secret|token|api[_ -]?key|access[_ -]?key|auth(?:orization)?)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi;
const SPOKEN_PASSWORD = /\b(pass(?:word|wd|phrase|code)?|pwd|otp)(\s+)(?!\[redacted\])("[^"]*"|'[^']*'|\S+)/gi;
const BEARER = /\bbearer\s+\S+/gi;
/** A long run of letters and digits mixed, like an API key or a token. */
const KEY_LIKE = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}/g;

/** A goal as an alert may show it: secret-looking values masked, whitespace collapsed, at most 80 characters. */
export function goalExcerpt(goal: string, max = ALERT_GOAL_CHARS): string {
  const text = goal
    .replace(/\s+/g, ' ')
    .trim()
    .replace(BEARER, 'Bearer [redacted]')
    .replace(NAMED_SECRET, (_m, name: string, sep: string) => `${name}${sep}[redacted]`)
    .replace(SPOKEN_PASSWORD, (_m, name: string, sep: string) => `${name}${sep}[redacted]`)
    .replace(KEY_LIKE, '[redacted]');
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** "run 1a2b3c4d of task "Nightly fares"", or, for a one-off goal, "run 1a2b3c4d ("<goal excerpt>")". */
export function describeRun(ref: AlertRunRef): string {
  const id = ref.runId.slice(0, 8);
  return ref.taskName ? `run ${id} of task "${goalExcerpt(ref.taskName)}"` : `run ${id} ("${goalExcerpt(ref.goal)}")`;
}

/** "$2.40", or "≥ $2.40" when part of it could not be priced. */
export function usd(amount: number, known = true): string {
  return `${known ? '' : '≥ '}$${amount.toFixed(2)}`;
}

let sources: AlertSources | null = null;
/** Set by `HexactraAlertsService`; `null` in tests that do not need it. */
export function setAlertSources(next: AlertSources | null): void {
  sources = next;
}
function need(): AlertSources {
  if (!sources) throw new Error('Hexactra alert sources are not ready');
  return sources;
}

export const HEXACTRA_ALERT_KINDS = {
  HOST_OFFLINE: 'hexactra_host_offline',
  SCHEDULE_FAILING: 'hexactra_schedule_failing',
  RUN_BUDGET: 'hexactra_run_budget',
  /** #408. Kind ids allow `[a-z0-9_]` only; the starter rule's key is `hexactra.run_stalled`. */
  RUN_STALLED: 'hexactra_run_stalled',
  /** #408. The starter rule's key is `hexactra.run_cost`. */
  RUN_COST_SPIKE: 'hexactra_run_cost',
} as const;

const hostOfflineConfig = z.object({ includeDraining: z.boolean().default(false) });
export const hostOfflineKind: AlertRuleKind<z.infer<typeof hostOfflineConfig>> = {
  id: HEXACTRA_ALERT_KINDS.HOST_OFFLINE,
  label: 'Browser host offline',
  description: 'A fabric browser host stopped polling, or the fabric itself is unreachable.',
  configSchema: hostOfflineConfig,
  async evaluate(_ctx, rule) {
    let hosts: Awaited<ReturnType<AlertSources['hosts']>>;
    try {
      hosts = await need().hosts();
      if (hosts === null) return [];
    } catch (e) {
      // The fabric down is the loudest "host offline" there is.
      return [{ labels: { fabric: 'control-plane' }, value: 1, breached: true, summary: `${rule.name}: the fabric is unreachable (${e instanceof Error ? e.message.slice(0, 160) : 'error'})` }];
    }
    const out: AlertObservation[] = [{ labels: { fabric: 'control-plane' }, value: 0, breached: false, summary: `${rule.name}: the fabric is reachable` }];
    for (const h of hosts) {
      if (h.draining && !rule.config.includeDraining) continue;
      const breached = !h.online;
      out.push({ labels: { 'host.id': h.id, 'host.name': h.name }, value: breached ? 1 : 0, breached, summary: `${rule.name}: host ${h.name} is ${breached ? 'offline' : 'online'}` });
    }
    return out;
  },
  describe: (rule) => `A browser host is offline${rule.config.includeDraining ? ' (draining hosts included)' : ''}, or the fabric is unreachable`,
};

const scheduleConfig = z.object({ minFailures: z.number().int().min(1).max(100).default(3) });
export const scheduleFailingKind: AlertRuleKind<z.infer<typeof scheduleConfig>> = {
  id: HEXACTRA_ALERT_KINDS.SCHEDULE_FAILING,
  label: 'Schedule failing',
  description: 'A task schedule failed several runs in a row.',
  configSchema: scheduleConfig,
  async evaluate(_ctx, rule) {
    const failing = await need().failingSchedules(rule.config.minFailures);
    return failing.map((s) => ({
      labels: { 'schedule.id': s.id },
      value: s.consecutiveFailures,
      breached: true,
      summary: `${rule.name}: "${s.taskName}" failed ${s.consecutiveFailures} runs in a row`,
    }));
  },
  describe: (rule) => `A schedule failed ${rule.config.minFailures} or more runs in a row`,
};

const budgetConfig = z.object({
  windowHours: z.number().int().min(1).max(168).default(24),
  maxTokens: z.number().int().min(1).default(2_000_000),
  /** USD per user per window; null (the default) checks no cost (#408). */
  maxCostUsd: z.number().positive().nullable().default(null),
  maxBudgetStops: z.number().int().min(1).default(5),
});
export const runBudgetKind: AlertRuleKind<z.infer<typeof budgetConfig>> = {
  id: HEXACTRA_ALERT_KINDS.RUN_BUDGET,
  label: 'Run budget exceeded',
  description: "A user's runs used more model tokens or money than allowed in the window, or keep hitting their budget.",
  configSchema: budgetConfig,
  async evaluate(ctx, rule) {
    const { windowHours, maxTokens, maxCostUsd, maxBudgetStops } = rule.config;
    const since = new Date(ctx.now.getTime() - windowHours * 3_600_000);
    const usage = await need().usage(since);
    return usage.map((u) => {
      const cost = u.costUsd ?? 0;
      const known = u.costKnown ?? true;
      const overTokens = u.tokens > maxTokens;
      const overCost = maxCostUsd !== null && cost > maxCostUsd;
      const overStops = u.budgetStops >= maxBudgetStops;
      const breached = overTokens || overCost || overStops;
      const why = [
        overTokens ? `${u.tokens} tokens (limit ${maxTokens})` : '',
        overCost ? `${usd(cost, known)} spent (limit ${usd(maxCostUsd)})` : '',
        overStops ? `${u.budgetStops} runs stopped by their budget` : '',
      ]
        .filter(Boolean)
        .join(', ');
      return {
        labels: { 'user.id': u.userId },
        value: u.tokens,
        breached,
        summary: breached ? `${rule.name}: in ${windowHours} h, ${why}` : `${rule.name}: ${u.runs} runs, ${u.tokens} tokens, ${usd(cost, known)} in ${windowHours} h`,
      };
    });
  },
  describe: (rule) =>
    `Over ${rule.config.windowHours} h: more than ${rule.config.maxTokens} tokens${rule.config.maxCostUsd !== null ? `, more than ${usd(rule.config.maxCostUsd)}` : ''}, or ${rule.config.maxBudgetStops}+ runs stopped by their budget`,
};

const stalledConfig = z.object({
  windowHours: z.number().int().min(1).max(168).default(24),
  minStalls: z.number().int().min(1).max(1_000).default(3),
});
export const runStalledKind: AlertRuleKind<z.infer<typeof stalledConfig>> = {
  id: HEXACTRA_ALERT_KINDS.RUN_STALLED,
  label: 'Runs stalling',
  description: "A user's runs keep ending stuck (stop reason `stalled`): the goal, the site or the model tiers need a look.",
  configSchema: stalledConfig,
  async evaluate(ctx, rule) {
    const { windowHours, minStalls } = rule.config;
    const since = new Date(ctx.now.getTime() - windowHours * 3_600_000);
    const rows = await need().stalls(since);
    return rows.map((u) => {
      const breached = u.stalls >= minStalls;
      return {
        labels: { 'user.id': u.userId },
        value: u.stalls,
        breached,
        summary: `${rule.name}: ${u.stalls} run${u.stalls === 1 ? '' : 's'} ended stuck in ${windowHours} h (latest: ${describeRun(u.latest)})`,
      };
    });
  },
  describe: (rule) => `${rule.config.minStalls}+ runs of one user ended stalled within ${rule.config.windowHours} h`,
};

const costSpikeConfig = z.object({
  maxRunCostUsd: z.number().positive().default(10),
  /** How far back runs are looked at; an expensive run resolves once it is older. */
  windowHours: z.number().int().min(1).max(168).default(24),
});
export const runCostSpikeKind: AlertRuleKind<z.infer<typeof costSpikeConfig>> = {
  id: HEXACTRA_ALERT_KINDS.RUN_COST_SPIKE,
  label: 'Expensive run',
  description: 'A single run cost more than the limit (useful under the Unlimited policy, which has no cost budget).',
  configSchema: costSpikeConfig,
  async evaluate(ctx, rule) {
    const { maxRunCostUsd, windowHours } = rule.config;
    const since = new Date(ctx.now.getTime() - windowHours * 3_600_000);
    const runs = await need().expensiveRuns(maxRunCostUsd, since);
    return runs.map((r) => ({
      labels: { 'run.id': r.runId, 'user.id': r.userId },
      value: r.costUsd,
      breached: true,
      summary: `${rule.name}: ${describeRun(r)} cost ${usd(r.costUsd, r.costKnown)} (limit ${usd(maxRunCostUsd)})`,
    }));
  },
  describe: (rule) => `One run cost more than ${usd(rule.config.maxRunCostUsd)} (runs of the last ${rule.config.windowHours} h)`,
};

registerAlertRuleKind(hostOfflineKind);
registerAlertRuleKind(scheduleFailingKind);
registerAlertRuleKind(runBudgetKind);
registerAlertRuleKind(runStalledKind);
registerAlertRuleKind(runCostSpikeKind);

/**
 * The rules the console creates once (by key); admins tune them at
 * Administration → Alerts. Keys are permanent too: a rule that exists is never
 * touched, so a new kind's rule reaches an existing deployment as a new key.
 */
export const HEXACTRA_ALERT_RULES = [
  { key: 'hexactra.host_offline', name: 'Browser host offline', kind: HEXACTRA_ALERT_KINDS.HOST_OFFLINE, severity: 'critical', config: { includeDraining: false }, forSeconds: 120, enabled: true },
  { key: 'hexactra.schedule_failing', name: 'Schedule failing', kind: HEXACTRA_ALERT_KINDS.SCHEDULE_FAILING, severity: 'warning', config: { minFailures: 3 }, forSeconds: 0, enabled: true },
  { key: 'hexactra.run_budget', name: 'Run budget exceeded', kind: HEXACTRA_ALERT_KINDS.RUN_BUDGET, severity: 'warning', config: { windowHours: 24, maxTokens: 2_000_000, maxCostUsd: null, maxBudgetStops: 5 }, forSeconds: 0, enabled: true },
  { key: 'hexactra.run_stalled', name: 'Runs stalling', kind: HEXACTRA_ALERT_KINDS.RUN_STALLED, severity: 'warning', config: { windowHours: 24, minStalls: 3 }, forSeconds: 0, enabled: true },
  // Off by default: the threshold depends on the deployment's prices.
  { key: 'hexactra.run_cost', name: 'Expensive run', kind: HEXACTRA_ALERT_KINDS.RUN_COST_SPIKE, severity: 'warning', config: { maxRunCostUsd: 10, windowHours: 24 }, forSeconds: 0, enabled: false },
] as const;
