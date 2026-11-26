// Connected AI apps (#464), as `/api/connected-apps` returns them
// (`connectedAppSchema` and `appPreflightSchema` in apps/api/src/connected-apps/).

export type AppScopeRisk = 'low' | 'elevated' | 'high';

export interface AppScope {
  id: string;
  /** "Delegate", "Tasks", "Inbox", "Drive browser", "JavaScript", "Desktop", "Policies". */
  label: string;
  /** What the consent page said. */
  consent: string;
  risk: AppScopeRisk;
}

export interface AppLimits {
  policyId: string | null;
  allowedPolicyIds: string[];
  allowedDomains: string[];
  maxConcurrentRuns: number;
  dailyRunLimit: number;
  dailyCostLimitUsd: number | null;
  confirmPurchases: boolean;
  /** Ask before the app's sensitive browser actions (#465); absent from an older console: on. */
  confirmSensitiveActions?: boolean;
  /** Let this app's runs sign in from the owner's saved logins (E37.3); absent from an older console: off. */
  allowSavedLogins?: boolean;
  /** Let this app's runs fill identity details from the owner's saved details (E37.6); absent from an older console: off. */
  allowSavedIdentity?: boolean;
  /** Let this app's runs pay with the owner's saved cards (E37.7); absent from an older console: off. */
  allowSavedCards?: boolean;
  /** Let this app's runs use the connections the owner switched on (E39.7); on for a new app since E50.17; absent from an older console: off. */
  allowConnections?: boolean;
  paused: boolean;
}

export interface AppUsage {
  runs30d: number;
  costUsd30d: number;
  costKnown: boolean;
  lastRunAt: string | null;
  liveRuns: number;
  runsToday: number;
  costTodayUsd: number;
}

export interface ConnectedApp {
  clientId: string;
  /** The active grant: what Disconnect revokes (`DELETE /api/oauth/grants/:id`); null once disconnected. */
  grantId: string | null;
  /** The client's host ("chatgpt.com"), or its own name for a local app. */
  name: string;
  /** "ChatGPT", "Claude", or `name`. */
  displayName: string;
  /** The name the client gives itself (self-asserted). */
  selfName: string | null;
  host: string | null;
  logoUri: string | null;
  verified: boolean;
  /** The client was deleted by an administrator. */
  removed: boolean;
  connectedAt: string | null;
  lastUsedAt: string | null;
  scopes: AppScope[];
  limits: AppLimits;
  usage: AppUsage;
}

export type PreflightStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface PreflightCheck {
  id: 'oauth_enabled' | 'public_url' | 'well_known';
  status: PreflightStatus;
  title: string;
  detail: string;
  fix: { who: 'admin' | 'you'; path: string | null; text: string } | null;
}

export type ConnectClientId = 'chatgpt' | 'claude' | 'claude-code' | 'other';

export interface AppPreflight {
  mcpUrl: string;
  admin: boolean;
  ready: boolean;
  checks: PreflightCheck[];
  clients: { id: ConnectClientId; allowed: boolean | null; hosts: string[]; detail: string }[];
}

/** Where a run was started from (`runs.origin`). */
export const RUN_ORIGINS = ['web', 'android', 'cli', 'api', 'mcp', 'schedule', 'system'] as const;
export type RunOrigin = (typeof RUN_ORIGINS)[number];

/** The app that started a run (a run payload's `client`). */
export interface RunClient {
  id: string | null;
  name: string | null;
  /** False: a name an MCP client gave itself (a personal access token). */
  verified: boolean;
}

/** Limits as the form edits them (text while typing). */
export interface LimitsDraft {
  policyId: string | null;
  allowedPolicyIds: string[];
  allowedDomains: string[];
  maxConcurrentRuns: string;
  dailyRunLimit: string;
  /** Empty: no cost limit. */
  dailyCostLimitUsd: string;
  confirmPurchases: boolean;
  confirmSensitiveActions: boolean;
  allowSavedLogins: boolean;
  allowSavedIdentity: boolean;
  allowSavedCards: boolean;
  allowConnections: boolean;
}

/** The highest values the API accepts (it may refuse more, above the deployment's ceilings). */
export const LIMIT_MAX = { maxConcurrentRuns: 20, dailyRunLimit: 1000, dailyCostLimitUsd: 10_000 } as const;

export function toDraft(l: AppLimits): LimitsDraft {
  return {
    policyId: l.policyId,
    allowedPolicyIds: [...l.allowedPolicyIds],
    allowedDomains: [...l.allowedDomains],
    maxConcurrentRuns: String(l.maxConcurrentRuns),
    dailyRunLimit: String(l.dailyRunLimit),
    dailyCostLimitUsd: l.dailyCostLimitUsd === null ? '' : String(l.dailyCostLimitUsd),
    confirmPurchases: l.confirmPurchases,
    confirmSensitiveActions: l.confirmSensitiveActions ?? true,
    allowSavedLogins: l.allowSavedLogins ?? false,
    allowSavedIdentity: l.allowSavedIdentity ?? false,
    allowSavedCards: l.allowSavedCards ?? false,
    allowConnections: l.allowConnections ?? false,
  };
}

/** Field errors of a draft; empty when it can be saved. */
export function draftErrors(d: LimitsDraft): Partial<Record<keyof LimitsDraft, string>> {
  const errors: Partial<Record<keyof LimitsDraft, string>> = {};
  const whole = (text: string, max: number) => {
    const n = Number(text);
    if (!text.trim() || !Number.isInteger(n)) return 'A whole number';
    if (n < 1 || n > max) return `From 1 to ${max.toLocaleString('en-US')}`;
    return null;
  };
  const conc = whole(d.maxConcurrentRuns, LIMIT_MAX.maxConcurrentRuns);
  if (conc) errors.maxConcurrentRuns = conc;
  const daily = whole(d.dailyRunLimit, LIMIT_MAX.dailyRunLimit);
  if (daily) errors.dailyRunLimit = daily;
  if (d.dailyCostLimitUsd.trim()) {
    const n = Number(d.dailyCostLimitUsd);
    if (!Number.isFinite(n) || n < 0.01 || n > LIMIT_MAX.dailyCostLimitUsd) errors.dailyCostLimitUsd = `An amount from $0.01 to $${LIMIT_MAX.dailyCostLimitUsd.toLocaleString('en-US')}`;
    else if (!/^\d+(\.\d{1,2})?$/.test(d.dailyCostLimitUsd.trim())) errors.dailyCostLimitUsd = 'At most two decimals';
  }
  if (d.policyId && d.allowedPolicyIds.length > 0 && !d.allowedPolicyIds.includes(d.policyId)) errors.policyId = 'Pick one of the allowed policies, or allow this one';
  return errors;
}

/** The PATCH body of a valid draft: only the fields that differ from `saved`. */
export function draftPatch(d: LimitsDraft, saved: AppLimits): Partial<AppLimits> {
  const next: Omit<AppLimits, 'paused'> = {
    policyId: d.policyId,
    allowedPolicyIds: d.allowedPolicyIds,
    allowedDomains: d.allowedDomains,
    maxConcurrentRuns: Number(d.maxConcurrentRuns),
    dailyRunLimit: Number(d.dailyRunLimit),
    dailyCostLimitUsd: d.dailyCostLimitUsd.trim() ? Math.round(Number(d.dailyCostLimitUsd) * 100) / 100 : null,
    confirmPurchases: d.confirmPurchases,
    confirmSensitiveActions: d.confirmSensitiveActions,
    allowSavedLogins: d.allowSavedLogins,
    allowSavedIdentity: d.allowSavedIdentity,
    allowSavedCards: d.allowSavedCards,
    allowConnections: d.allowConnections,
  };
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) {
    const before = k === 'confirmSensitiveActions' ? (saved.confirmSensitiveActions ?? true) : k === 'allowSavedLogins' ? (saved.allowSavedLogins ?? false) : k === 'allowSavedIdentity' ? (saved.allowSavedIdentity ?? false) : k === 'allowSavedCards' ? (saved.allowSavedCards ?? false) : k === 'allowConnections' ? (saved.allowConnections ?? false) : saved[k as keyof AppLimits];
    if (JSON.stringify(v) !== JSON.stringify(before)) patch[k] = v;
  }
  return patch as Partial<AppLimits>;
}
