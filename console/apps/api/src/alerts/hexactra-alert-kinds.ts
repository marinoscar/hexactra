// The console's own alert rule kinds, evaluated by the platform alerts slice
// (`@marinoscar/platform-api/alerts`) every minute: a browser host offline,
// a schedule failing, runs exceeding their budgets. Each returns one
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
  /** Per user, since `since`: tokens used and runs stopped by a step or time budget. */
  usage(since: Date): Promise<{ userId: string; tokens: number; budgetStops: number; runs: number }[]>;
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
  maxBudgetStops: z.number().int().min(1).default(5),
});
export const runBudgetKind: AlertRuleKind<z.infer<typeof budgetConfig>> = {
  id: HEXACTRA_ALERT_KINDS.RUN_BUDGET,
  label: 'Run budget exceeded',
  description: "A user's runs used more model tokens than allowed, or keep hitting their step or time budget.",
  configSchema: budgetConfig,
  async evaluate(ctx, rule) {
    const since = new Date(ctx.now.getTime() - rule.config.windowHours * 3_600_000);
    const usage = await need().usage(since);
    return usage.map((u) => {
      const overTokens = u.tokens > rule.config.maxTokens;
      const overStops = u.budgetStops >= rule.config.maxBudgetStops;
      const breached = overTokens || overStops;
      const why = [overTokens ? `${u.tokens} tokens (limit ${rule.config.maxTokens})` : '', overStops ? `${u.budgetStops} runs stopped by their budget` : ''].filter(Boolean).join(', ');
      return {
        labels: { 'user.id': u.userId },
        value: u.tokens,
        breached,
        summary: breached ? `${rule.name}: in ${rule.config.windowHours} h, ${why}` : `${rule.name}: ${u.runs} runs, ${u.tokens} tokens in ${rule.config.windowHours} h`,
      };
    });
  },
  describe: (rule) => `Over ${rule.config.windowHours} h: more than ${rule.config.maxTokens} tokens, or ${rule.config.maxBudgetStops}+ runs stopped by their budget`,
};

registerAlertRuleKind(hostOfflineKind);
registerAlertRuleKind(scheduleFailingKind);
registerAlertRuleKind(runBudgetKind);

/** The rules the console creates once (by key), enabled; admins tune them at Administration → Alerts. */
export const HEXACTRA_ALERT_RULES = [
  { key: 'hexactra.host_offline', name: 'Browser host offline', kind: HEXACTRA_ALERT_KINDS.HOST_OFFLINE, severity: 'critical', config: { includeDraining: false }, forSeconds: 120 },
  { key: 'hexactra.schedule_failing', name: 'Schedule failing', kind: HEXACTRA_ALERT_KINDS.SCHEDULE_FAILING, severity: 'warning', config: { minFailures: 3 }, forSeconds: 0 },
  { key: 'hexactra.run_budget', name: 'Run budget exceeded', kind: HEXACTRA_ALERT_KINDS.RUN_BUDGET, severity: 'warning', config: { windowHours: 24, maxTokens: 2_000_000, maxBudgetStops: 5 }, forSeconds: 0 },
] as const;
