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

import { RUN_READING_ALERT_KINDS } from './run-alert-kinds';

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
  /** Saved approvals (#554) used at least `minUses` times since `since`, busiest first. Optional: a source that predates #554 has none. */
  busyApprovals?(minUses: number, since: Date): Promise<BusyApproval[]>;
  /** Runs created since `since` that were recovered at least `minRecoveries` times after an interruption (E38.3), most recovered first. Optional. */
  recoveredRuns?(minRecoveries: number, since: Date): Promise<RecoveredRun[]>;
  /** Deliveries (E39.6, #603) whose runs failed to deliver at least `minFailures` times since `since`, most failures first. Optional. */
  failingDeliveries?(minFailures: number, since: Date): Promise<FailingDelivery[]>;
  /** Saved card payments (E37.7) per user since `since`: how many cards were typed (`number` released) and the largest declared amount. Optional. */
  cardUsage?(since: Date): Promise<CardUsage[]>;
  /** AI spend since the start of the current UTC month (#736): in total and per user, at the deployment's prices. Optional. */
  monthlyAiSpend?(now: Date): Promise<MonthlyAiSpend>;
}

/** AI spend this month (#736): USD and whether every call was priced; users by id only. */
export interface MonthlyAiSpend {
  since: Date;
  totalUsd: number;
  totalKnown: boolean;
  users: { userId: string | null; usd: number; known: boolean }[];
}

/** A run whose job was interrupted again and again (E38.3): which run and how many times; never a step or a page. */
export interface RecoveredRun extends AlertRunRef {
  userId: string;
  recoveries: number;
}

/** One delivery that kept failing (E39.6): its id, kind and the task's name; never an address, a subject, a cell or a file name. */
export interface FailingDelivery {
  deliveryId: string;
  userId: string;
  kind: string;
  taskName: string | null;
  failures: number;
}

/** One user's saved-card payments in a window: counts and the largest declared amount; never a card, a merchant or a value. */
export interface CardUsage {
  userId: string;
  uses: number;
  /** The largest declared amount, a decimal with two places, with its currency; null when none was recorded. */
  largest: { amount: string; currency: string } | null;
}

/** A saved approval that was used a lot: ids, kind and category only (never a page label). */
export interface BusyApproval {
  ruleId: string;
  userId: string;
  kind: string;
  category: string | null;
  uses: number;
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
  /** #554. The starter rule's key is `hexactra.approval_busy`. */
  APPROVAL_BUSY: 'hexactra_approval_busy',
  /** E37.7. The starter rule's key is `hexactra.card_use`. */
  CARD_USE: 'hexactra_card_use',
  /** E38.3. The starter rule's key is `hexactra.run_recovered`. */
  RUN_RECOVERED: 'hexactra_run_recovered',
  /** E39.6. The starter rule's key is `hexactra.delivery_failing`. */
  DELIVERY_FAILING: 'hexactra_delivery_failing',
  /** #736. The starter rule's key is `hexactra.ai_spend_monthly`. */
  AI_SPEND_MONTHLY: 'hexactra_ai_spend_monthly',
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

const approvalBusyConfig = z.object({
  /** Uses of one saved approval in the window that fire the alert. */
  maxUses: z.number().int().min(1).max(10_000).default(20),
  windowHours: z.number().int().min(1).max(168).default(24),
});
export const approvalBusyKind: AlertRuleKind<z.infer<typeof approvalBusyConfig>> = {
  id: HEXACTRA_ALERT_KINDS.APPROVAL_BUSY,
  label: 'Saved approval used a lot',
  description: 'One saved approval let the agent go ahead more often than expected in a day: a loop that keeps pressing a remembered button is noticed.',
  configSchema: approvalBusyConfig,
  async evaluate(ctx, rule) {
    const { maxUses, windowHours } = rule.config;
    const since = new Date(ctx.now.getTime() - windowHours * 3_600_000);
    const busy = (await need().busyApprovals?.(maxUses + 1, since)) ?? [];
    return busy.map((b) => ({
      labels: { 'approval_rule.id': b.ruleId, 'user.id': b.userId },
      value: b.uses,
      breached: true,
      summary: `${rule.name}: a saved approval (${b.kind}${b.category ? `, ${b.category}` : ''}) was used ${b.uses} times in ${windowHours} h (limit ${maxUses})`,
    }));
  },
  describe: (rule) => `One saved approval used more than ${rule.config.maxUses} times within ${rule.config.windowHours} h`,
};

const cardUseConfig = z.object({
  /** Card payments of one user in the window that fire the alert. */
  maxUses: z.number().int().min(1).max(1_000).default(5),
  /** A single declared amount above this (any currency) fires it; null checks no amount. */
  maxAmount: z.number().positive().nullable().default(null),
  windowHours: z.number().int().min(1).max(168).default(24),
});
export const cardUseKind: AlertRuleKind<z.infer<typeof cardUseConfig>> = {
  id: HEXACTRA_ALERT_KINDS.CARD_USE,
  label: 'Saved card used a lot',
  description: "A user's agents paid with saved cards more often than expected in a day, or one payment was above the deployment's threshold.",
  configSchema: cardUseConfig,
  async evaluate(ctx, rule) {
    const { maxUses, maxAmount, windowHours } = rule.config;
    const since = new Date(ctx.now.getTime() - windowHours * 3_600_000);
    const rows = (await need().cardUsage?.(since)) ?? [];
    return rows.map((u) => {
      const overUses = u.uses > maxUses;
      const overAmount = maxAmount !== null && u.largest !== null && Number(u.largest.amount) > maxAmount;
      const breached = overUses || overAmount;
      const why = [overUses ? `${u.uses} card payments (limit ${maxUses})` : '', overAmount ? `a payment of ${u.largest!.amount} ${u.largest!.currency} (limit ${maxAmount})` : ''].filter(Boolean).join(', ');
      return { labels: { 'user.id': u.userId }, value: u.uses, breached, summary: breached ? `${rule.name}: in ${windowHours} h, ${why}` : `${rule.name}: ${u.uses} card payment${u.uses === 1 ? '' : 's'} in ${windowHours} h` };
    });
  },
  describe: (rule) => `More than ${rule.config.maxUses} saved-card payments of one user within ${rule.config.windowHours} h${rule.config.maxAmount !== null ? `, or one above ${rule.config.maxAmount}` : ''}`,
};

const recoveredConfig = z.object({
  /** Recoveries of one run that fire the alert: more than three by default. */
  minRecoveries: z.number().int().min(1).max(100).default(4),
  windowHours: z.number().int().min(1).max(168).default(24),
});
export const runRecoveredKind: AlertRuleKind<z.infer<typeof recoveredConfig>> = {
  id: HEXACTRA_ALERT_KINDS.RUN_RECOVERED,
  label: 'Run keeps being interrupted',
  description: "A run's job was interrupted and the run carried on from its last recorded step more than a few times: a worker that keeps dying, a deploy loop or a run that crashes the runner.",
  configSchema: recoveredConfig,
  async evaluate(ctx, rule) {
    const { minRecoveries, windowHours } = rule.config;
    const since = new Date(ctx.now.getTime() - windowHours * 3_600_000);
    const runs = (await need().recoveredRuns?.(minRecoveries, since)) ?? [];
    return runs.map((r) => ({
      labels: { 'run.id': r.runId, 'user.id': r.userId },
      value: r.recoveries,
      breached: true,
      summary: `${rule.name}: ${describeRun(r)} was recovered after an interruption ${r.recoveries} times (limit ${minRecoveries - 1})`,
    }));
  },
  describe: (rule) => `One run recovered ${rule.config.minRecoveries} or more times after an interruption (runs of the last ${rule.config.windowHours} h)`,
};

const deliveryFailingConfig = z.object({
  /** Failed deliveries of one delivery in the window that fire the alert. */
  minFailures: z.number().int().min(1).max(100).default(3),
  windowHours: z.number().int().min(1).max(168).default(24),
});
export const deliveryFailingKind: AlertRuleKind<z.infer<typeof deliveryFailingConfig>> = {
  id: HEXACTRA_ALERT_KINDS.DELIVERY_FAILING,
  label: 'Delivery keeps failing',
  description: 'The email, spreadsheet row, file or webhook a task sends after its runs failed several times: a connection that needs reconnecting, a folder that was removed, a destination that is down.',
  configSchema: deliveryFailingConfig,
  async evaluate(ctx, rule) {
    const { minFailures, windowHours } = rule.config;
    const since = new Date(ctx.now.getTime() - windowHours * 3_600_000);
    const rows = (await need().failingDeliveries?.(minFailures, since)) ?? [];
    return rows.map((d) => ({
      labels: { 'delivery.id': d.deliveryId, 'user.id': d.userId },
      value: d.failures,
      breached: true,
      summary: `${rule.name}: a ${d.kind} delivery${d.taskName ? ` of task "${goalExcerpt(d.taskName)}"` : ''} failed ${d.failures} times in ${windowHours} h (limit ${minFailures - 1})`,
    }));
  },
  describe: (rule) => `One delivery failed ${rule.config.minFailures} or more times within ${rule.config.windowHours} h`,
};

const monthlySpendConfig = z
  .object({
    /** The most the whole deployment should spend on AI in a calendar month (UTC), USD; null checks no total. */
    maxDeploymentUsd: z.number().positive().nullable().default(null),
    /** The most one user should spend in a month, USD; null checks no user. */
    maxUserUsd: z.number().positive().nullable().default(null),
    /** Fire once spend reaches this share of a limit (100 fires only at the limit). */
    warnAtPercent: z.number().int().min(1).max(100).default(80),
  });
// Both amounts null checks nothing (the rule then never fires).
export const aiSpendMonthlyKind: AlertRuleKind<z.infer<typeof monthlySpendConfig>> = {
  id: HEXACTRA_ALERT_KINDS.AI_SPEND_MONTHLY,
  label: 'Monthly AI spend',
  description: "AI spend this calendar month (UTC), from every model call at the deployment's model prices, reached a share of the deployment's or one user's monthly amount.",
  configSchema: monthlySpendConfig,
  async evaluate(ctx, rule) {
    const source = need().monthlyAiSpend;
    if (!source) return [];
    const { maxDeploymentUsd, maxUserUsd, warnAtPercent } = rule.config;
    const spend = await source(ctx.now);
    const share = (usd: number, max: number) => Math.round((usd / max) * 100);
    const out: AlertObservation[] = [];
    if (maxDeploymentUsd !== null) {
      const pct = share(spend.totalUsd, maxDeploymentUsd);
      out.push({
        labels: { scope: 'deployment' },
        value: spend.totalUsd,
        breached: pct >= warnAtPercent,
        summary: `${rule.name}: the deployment spent ${usd(spend.totalUsd, spend.totalKnown)} on AI this month, ${pct}% of ${usd(maxDeploymentUsd)}`,
      });
    }
    if (maxUserUsd !== null) {
      for (const u of spend.users) {
        if (!u.userId) continue;
        const pct = share(u.usd, maxUserUsd);
        if (pct < warnAtPercent) continue;
        out.push({ labels: { 'user.id': u.userId }, value: u.usd, breached: true, summary: `${rule.name}: a user spent ${usd(u.usd, u.known)} on AI this month, ${pct}% of ${usd(maxUserUsd)}` });
      }
    }
    return out;
  },
  describe: (rule) =>
    [
      rule.config.maxDeploymentUsd !== null ? `the deployment's AI spend this month reaches ${rule.config.warnAtPercent}% of ${usd(rule.config.maxDeploymentUsd)}` : null,
      rule.config.maxUserUsd !== null ? `one user's reaches ${rule.config.warnAtPercent}% of ${usd(rule.config.maxUserUsd)}` : null,
    ]
      .filter(Boolean)
      .join(', or '),
};

// Run retention keeps runs for these kinds' windows: a new kind that reads `runs` joins the list.
const RUN_READERS: readonly string[] = [HEXACTRA_ALERT_KINDS.RUN_BUDGET, HEXACTRA_ALERT_KINDS.RUN_STALLED, HEXACTRA_ALERT_KINDS.RUN_COST_SPIKE, HEXACTRA_ALERT_KINDS.RUN_RECOVERED, HEXACTRA_ALERT_KINDS.DELIVERY_FAILING];
if (RUN_READING_ALERT_KINDS.length !== RUN_READERS.length || RUN_READING_ALERT_KINDS.some((k) => !RUN_READERS.includes(k))) {
  throw new Error('RUN_READING_ALERT_KINDS (run-alert-kinds.ts) must list exactly the alert kinds that read runs');
}

registerAlertRuleKind(hostOfflineKind);
registerAlertRuleKind(scheduleFailingKind);
registerAlertRuleKind(runBudgetKind);
registerAlertRuleKind(runStalledKind);
registerAlertRuleKind(runCostSpikeKind);
registerAlertRuleKind(approvalBusyKind);
registerAlertRuleKind(cardUseKind);
registerAlertRuleKind(runRecoveredKind);
registerAlertRuleKind(deliveryFailingKind);
registerAlertRuleKind(aiSpendMonthlyKind);

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
  // #554: a saved approval that keeps being used (a loop pressing a remembered button).
  { key: 'hexactra.approval_busy', name: 'Saved approval used a lot', kind: HEXACTRA_ALERT_KINDS.APPROVAL_BUSY, severity: 'warning', config: { maxUses: 20, windowHours: 24 }, forSeconds: 0, enabled: true },
  // E37.7: saved cards are the highest-risk secret: more than five payments a day in one account, or a payment above the threshold the administrator sets.
  { key: 'hexactra.card_use', name: 'Saved card used a lot', kind: HEXACTRA_ALERT_KINDS.CARD_USE, severity: 'warning', config: { maxUses: 5, maxAmount: null, windowHours: 24 }, forSeconds: 0, enabled: true },
  // E38.3: a run whose job keeps dying: more than three recoveries of one run in a day.
  { key: 'hexactra.run_recovered', name: 'Run keeps being interrupted', kind: HEXACTRA_ALERT_KINDS.RUN_RECOVERED, severity: 'warning', config: { minRecoveries: 4, windowHours: 24 }, forSeconds: 0, enabled: true },
  // E39.6: a delivery after a run that failed three times in a day (its runs read the log, so retention keeps them as long as the window).
  { key: 'hexactra.delivery_failing', name: 'Delivery keeps failing', kind: HEXACTRA_ALERT_KINDS.DELIVERY_FAILING, severity: 'warning', config: { minFailures: 3, windowHours: 24 }, forSeconds: 0, enabled: true },
  // #736: off by default, like the expensive run: the amounts depend on the deployment's prices and budget.
  { key: 'hexactra.ai_spend_monthly', name: 'Monthly AI spend', kind: HEXACTRA_ALERT_KINDS.AI_SPEND_MONTHLY, severity: 'warning', config: { maxDeploymentUsd: 500, maxUserUsd: null, warnAtPercent: 80 }, forSeconds: 0, enabled: false },
] as const;
