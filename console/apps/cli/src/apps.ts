// Connected AI apps (#464), CLI side: the view of `GET /api/connected-apps`,
// how an app is named on the command line, and how its limits read.
import { consoleApi } from './console-api.js';

export interface AppScopeView {
  id: string;
  label: string;
  consent: string;
  risk: 'low' | 'elevated' | 'high';
}

export interface AppLimitsView {
  policyId: string | null;
  allowedPolicyIds: string[];
  allowedDomains: string[];
  maxConcurrentRuns: number;
  dailyRunLimit: number;
  dailyCostLimitUsd: number | null;
  confirmPurchases: boolean;
  /** Ask before the app's sensitive browser actions (#465); absent on an older console. */
  confirmSensitiveActions?: boolean;
  paused: boolean;
}

export interface AppView {
  clientId: string;
  grantId: string | null;
  name: string;
  displayName: string;
  selfName: string | null;
  host: string | null;
  verified: boolean;
  removed: boolean;
  connectedAt: string | null;
  lastUsedAt: string | null;
  scopes: AppScopeView[];
  limits: AppLimitsView;
  usage: { runs30d: number; costUsd30d: number; costKnown: boolean; lastRunAt: string | null; liveRuns: number; runsToday: number; costTodayUsd: number };
}

/** The app a reference names: its client id, an id prefix (8 characters or more), its host or its name (case-insensitive). */
export function findApp(apps: readonly AppView[], ref: string): AppView {
  const r = ref.trim().toLowerCase();
  const hit =
    apps.find((a) => a.clientId === r) ??
    (r.length >= 4 ? apps.find((a) => a.clientId.startsWith(r)) : undefined) ??
    apps.find((a) => a.name.toLowerCase() === r || a.displayName.toLowerCase() === r || (a.host ?? '').toLowerCase() === r);
  if (!hit) throw new Error(`No connected AI app matches "${ref}". \`apps list\` shows them.`);
  return hit;
}

/** Look an app up on the console. */
export async function resolveApp(ref: string): Promise<AppView> {
  return findApp(await consoleApi().get<AppView[]>('/connected-apps'), ref);
}

const usd = (n: number, known = true) => `${known ? '' : '≥ '}$${n.toFixed(2)}`;

/** One line of `apps list`. */
export function appLine(a: AppView): string {
  const scopes = [...new Set(a.scopes.filter((s) => s.id !== 'offline_access').map((s) => (s.risk === 'low' ? s.label : `${s.label}!`)))].join(', ');
  return [a.clientId.slice(0, 8), a.displayName.padEnd(14), a.limits.paused ? 'PAUSED ' : 'active ', `${a.usage.runs30d} runs/30d`.padEnd(13), usd(a.usage.costUsd30d, a.usage.costKnown).padEnd(8), scopes].join('  ');
}

/** The limits, one per line. */
export function limitLines(l: AppLimitsView): string[] {
  return [
    `paused: ${l.paused ? 'yes' : 'no'}`,
    `policy: ${l.policyId ?? "the user's default"}${l.allowedPolicyIds.length ? ` (allowed: ${l.allowedPolicyIds.join(', ')})` : ''}`,
    `sites: ${l.allowedDomains.join(', ') || "no extra limit (the task's own)"}`,
    `runs at once: ${l.maxConcurrentRuns}`,
    `runs per day: ${l.dailyRunLimit}`,
    `spend per day: ${l.dailyCostLimitUsd === null ? 'no limit' : usd(l.dailyCostLimitUsd)}`,
    `ask before purchases: ${l.confirmPurchases ? 'always' : 'as the task says'}`,
    ...(l.confirmSensitiveActions !== undefined ? [`ask before sensitive browser actions: ${l.confirmSensitiveActions ? 'yes' : 'no'}`] : []),
  ];
}

/** The body of `apps limits` from its options; only what was passed. */
export function limitsPatch(o: { policy?: string; allowPolicies?: string; maxRuns?: string; dailyRuns?: string; dailyCost?: string; sites?: string; confirm?: boolean; confirmSensitive?: boolean }): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const int = (v: string, what: string) => {
    const n = Number.parseInt(v, 10);
    if (!Number.isInteger(n) || String(n) !== v.trim()) throw new Error(`${what} must be a whole number`);
    return n;
  };
  const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);
  if (o.policy !== undefined) body.policyId = o.policy === '' || o.policy === 'default' ? null : o.policy;
  if (o.allowPolicies !== undefined) body.allowedPolicyIds = list(o.allowPolicies);
  if (o.maxRuns !== undefined) body.maxConcurrentRuns = int(o.maxRuns, '--max-runs');
  if (o.dailyRuns !== undefined) body.dailyRunLimit = int(o.dailyRuns, '--daily-runs');
  if (o.dailyCost !== undefined) {
    if (o.dailyCost === '' || o.dailyCost === 'none') body.dailyCostLimitUsd = null;
    else {
      const n = Number(o.dailyCost);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--daily-cost must be a positive amount in USD, or "none"');
      body.dailyCostLimitUsd = Math.round(n * 100) / 100;
    }
  }
  if (o.sites !== undefined) body.allowedDomains = list(o.sites);
  if (o.confirm !== undefined) body.confirmPurchases = o.confirm;
  if (o.confirmSensitive !== undefined) body.confirmSensitiveActions = o.confirmSensitive;
  return body;
}

/** Who started a run, as `runs list` shows it. */
export function startedBy(run: { origin?: string; client?: { name: string | null; verified: boolean } | null }): string {
  if (run.client?.name) return `${run.client.name}${run.client.verified ? '' : '?'}`;
  const words: Record<string, string> = { web: 'console', android: 'android', cli: 'cli', api: 'api', mcp: 'ai app', schedule: 'schedule', system: 'system' };
  return words[run.origin ?? ''] ?? '-';
}

/** One row of `GET /api/connected-apps/activity` (#465). */
export interface ActivityRow {
  createdAt: string;
  event: string;
  credentialKind: string;
  clientName: string | null;
  tool: string | null;
  outcome: string;
  errorCode: string | null;
  durationMs: number;
  runId: string | null;
  sessionId: string | null;
  detail: Record<string, unknown> | null;
}

/** One activity row in a line: when, who, what, how it ended. */
export function activityLine(r: ActivityRow): string {
  const who = r.clientName ?? (r.credentialKind === 'pat' ? 'personal access token' : r.credentialKind === 'jwt' ? 'you (console)' : 'an AI app');
  const what = r.tool ?? r.event.replace(/_/g, ' ');
  const target = r.runId ? ` run ${r.runId.slice(0, 8)}` : r.sessionId ? ` session ${r.sessionId.slice(0, 8)}` : '';
  const host = typeof r.detail?.host === 'string' ? ` ${r.detail.host}` : '';
  const ended = r.outcome === 'ok' ? 'ok' : `${r.outcome}${r.errorCode ? ` (${r.errorCode})` : ''}`;
  return [r.createdAt.replace('T', ' ').slice(0, 19), who.padEnd(16), `${what}${target}${host}`.padEnd(40), ended].join('  ');
}
