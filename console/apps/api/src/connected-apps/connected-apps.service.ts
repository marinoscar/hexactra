// Connected AI apps (#464): the per-app limits, their enforcement where runs
// and browser sessions start, and the list the "AI apps" page shows.
//
// Enforcement is keyed on the request's client context (request-client.ts),
// so it holds for every tool and every REST route that starts work. A refusal
// is thrown before anything is written. Usage (runs, spend, live runs) is
// always counted from `runs` through the index `(user_id, client_id,
// created_at)`, never stored, so it cannot drift.
import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { SettingsResolver, SystemSettingsService } from '@marinoscar/platform-api/settings';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import { zonedDateKey, zonedDayStart } from '@marinoscar/platform-contract/timezone';
import { Prisma } from '@prisma/client';

import { PoliciesService } from '../policies/policies.service';
import { PrismaService } from '../prisma/prisma.service';
import { domainAllowed } from '../runner/policy';
import { MCP_SCOPES } from '../mcp/mcp.scopes';
import { McpActivityService } from '../mcp/mcp-activity.service';
import { AppLimitError } from './connected-apps.errors';
import { APP_CEILING_DEFAULTS, APP_LIMIT_DEFAULTS, type AppLimits, type ConnectedAppView, type RunAppLimits } from './connected-apps.schemas';
import { APP_FIRST_RUN_EVENT } from './connected-apps.notifications';
import { clientLabel, friendlyAppName, type RequestClient } from './request-client';

const LIVE = ['queued', 'running', 'waiting_human', 'paused'] as const;
const DAY_MS = 86_400_000;

/** The short words of each scope (the list's chips). */
export const SCOPE_LABELS: Readonly<Record<string, string>> = {
  'runs:read': 'See runs',
  'runs:write': 'Delegate',
  'tasks:write': 'Tasks',
  'inbox:read': 'Inbox',
  'inbox:write': 'Inbox',
  'procedures:read': 'Procedures',
  'procedures:run': 'Run procedures',
  'browser:drive': 'Drive browser',
  'browser:evaluate': 'JavaScript',
  'desktop:control': 'Desktop',
  'policies:write': 'Policies',
  offline_access: 'Stay connected',
};

/** The scopes a step-up is announced for (`app.scope_added`). */
export const HIGH_RISK_SCOPES = ['browser:drive', 'browser:evaluate', 'desktop:control', 'policies:write'] as const;

/** A grant's scopes in words, in consent order. */
export function scopeViews(scopes: readonly string[]): ConnectedAppView['scopes'] {
  const known = MCP_SCOPES.filter((s) => scopes.includes(s.id)).map((s) => ({ id: s.id, label: SCOPE_LABELS[s.id] ?? s.id, consent: s.title, risk: s.risk === 'high' ? ('high' as const) : s.risk === 'elevated' ? ('elevated' as const) : ('low' as const) }));
  const offline = scopes.includes('offline_access') ? [{ id: 'offline_access', label: SCOPE_LABELS.offline_access, consent: 'Stay connected without asking you to sign in again', risk: 'low' as const }] : [];
  return [...known, ...offline];
}

/** The scopes in a sentence: "Delegate, Tasks, Inbox and Drive browser". */
export function scopesInWords(scopes: readonly string[]): string {
  const labels = [...new Set(scopeViews(scopes).filter((s) => s.id !== 'offline_access').map((s) => s.label))];
  if (labels.length === 0) return 'no permissions';
  return labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

/** The instant the calendar day of `now` begins in `timeZone` (UTC for a zone the runtime does not know). */
export function startOfDayIn(timeZone: string, now: Date = new Date()): Date {
  try {
    return zonedDayStart(zonedDateKey(now, timeZone), timeZone);
  } catch {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
}

type SettingsRow = Prisma.ConnectedAppSettingsGetPayload<object>;

/** A row (or the defaults) as limits. */
export function limitsOf(row: SettingsRow | null): AppLimits {
  if (!row) return { ...APP_LIMIT_DEFAULTS, allowedPolicyIds: [], allowedDomains: [] };
  return {
    policyId: row.policyId,
    allowedPolicyIds: [...row.allowedPolicyIds],
    allowedDomains: [...row.allowedDomains],
    maxConcurrentRuns: row.maxConcurrentRuns,
    dailyRunLimit: row.dailyRunLimit,
    dailyCostLimitUsd: row.dailyCostLimitUsd === null ? null : Number(row.dailyCostLimitUsd),
    confirmPurchases: row.confirmPurchases,
    confirmSensitiveActions: row.confirmSensitiveActions,
    allowSavedLogins: row.allowSavedLogins,
    allowSavedIdentity: row.allowSavedIdentity,
    allowSavedCards: row.allowSavedCards,
    allowConnections: row.allowConnections,
    paused: row.paused,
  };
}

/** Limits under the deployment's ceilings: a limit never exceeds what the administrator allows. */
export function clampLimits(limits: AppLimits, ceilings: { maxConcurrentRunsPerApp: number; maxDailyRunsPerApp: number }): AppLimits {
  return { ...limits, maxConcurrentRuns: Math.min(limits.maxConcurrentRuns, ceilings.maxConcurrentRunsPerApp), dailyRunLimit: Math.min(limits.dailyRunLimit, ceilings.maxDailyRunsPerApp) };
}

/** What starting work asks of the limits. */
export interface StartCheck {
  /** `run`: a goal run; `session`: an external browser session. */
  kind: 'run' | 'session';
  /** The policy the call named (`policy_id`). */
  policyId?: string | null;
  /** The task's own policy, for a task run. */
  taskPolicyRef?: string | null;
  /** The task's (or session's) own allowed sites. */
  allowedDomains?: readonly string[];
}

/** What a run or session that passed the limits carries. */
export interface StartDecision {
  /** Recorded on the run (`app_limits`) and copied into its policy snapshot; null for a caller that is not an OAuth app. */
  appLimits: RunAppLimits | null;
  /** A policy the app's limits chose for this run (`policy_source: run`), when the call named none. */
  policyOverride: string | null;
}

@Injectable()
export class ConnectedAppsService {
  private readonly log = new Logger(ConnectedAppsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly policies?: PoliciesService,
    @Optional() private readonly system?: SystemSettingsService,
    @Optional() private readonly settings?: SettingsResolver,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly activity?: McpActivityService,
  ) {}

  /** The wall clock; tests replace it. */
  clock: () => Date = () => new Date();

  /** The deployment's ceilings (`mcp.maxConcurrentRunsPerApp`, `mcp.maxDailyRunsPerApp`). */
  async ceilings(): Promise<{ maxConcurrentRunsPerApp: number; maxDailyRunsPerApp: number }> {
    try {
      const v = (await this.system?.getNamespace('mcp')) as { maxConcurrentRunsPerApp?: number; maxDailyRunsPerApp?: number } | undefined;
      return {
        maxConcurrentRunsPerApp: v?.maxConcurrentRunsPerApp ?? APP_CEILING_DEFAULTS.maxConcurrentRunsPerApp,
        maxDailyRunsPerApp: v?.maxDailyRunsPerApp ?? APP_CEILING_DEFAULTS.maxDailyRunsPerApp,
      };
    } catch {
      return { ...APP_CEILING_DEFAULTS };
    }
  }

  private db(userId: string) {
    return this.prisma.forUser({ userId });
  }

  private async row(userId: string, clientId: string): Promise<SettingsRow | null> {
    return this.db(userId).connectedAppSettings.findFirst({ where: { clientId } });
  }

  /** The user's day so far: from midnight in their profile time zone. */
  private async dayStart(userId: string): Promise<Date> {
    const zone = (await this.settings?.resolveUserTimeZone(userId).catch(() => null)) ?? 'UTC';
    return startOfDayIn(zone, this.clock());
  }

  /** The effective limits of one app (defaults when the row does not exist yet), under the ceilings. */
  async limits(userId: string, clientId: string): Promise<AppLimits> {
    return clampLimits(limitsOf(await this.row(userId, clientId)), await this.ceilings());
  }

  /**
   * Check the limits of the app behind `client` before a run or session
   * starts. A caller that is not an OAuth app passes with no limits. Throws
   * `AppLimitError` (403) on a refusal; nothing has been written then.
   */
  async checkStart(userId: string, client: RequestClient, check: StartCheck): Promise<StartDecision> {
    if (!client.clientId) return { appLimits: null, policyOverride: null };
    const limits = await this.limits(userId, client.clientId);
    if (limits.paused) throw new AppLimitError('APP_PAUSED');

    // Policies: the one named must be allowed; without one, the app's own, else the first allowed one.
    let policyOverride: string | null = null;
    const allowed = limits.allowedPolicyIds;
    if (check.policyId) {
      if (allowed.length > 0 && !allowed.includes(check.policyId)) throw new AppLimitError('APP_POLICY_NOT_ALLOWED', { policyId: check.policyId });
    } else {
      let candidate = limits.policyId ?? check.taskPolicyRef ?? null;
      if (limits.policyId) policyOverride = limits.policyId;
      if (allowed.length > 0) {
        candidate ??= this.policies ? (await this.policies.getDefault(userId)).policyId : null;
        if (!candidate || !allowed.includes(candidate)) policyOverride = allowed[0];
      }
    }

    // Sites: the app's list is intersected with the task's own. Lists that cannot meet leave nothing to visit.
    const own = check.allowedDomains ?? [];
    if (limits.allowedDomains.length > 0 && own.length > 0 && !own.some((d) => domainAllowed(`https://${d.replace(/^\*\./, 'x.')}/`, limits.allowedDomains) || limits.allowedDomains.some((a) => domainAllowed(`https://${a.replace(/^\*\./, 'x.')}/`, own)))) {
      throw new AppLimitError('APP_DOMAIN_NOT_ALLOWED', { site: own.join(', ') });
    }

    // Counters, from the runs of this app.
    const db = this.db(userId);
    const live = await db.run.count({ where: { clientId: client.clientId, status: { in: [...LIVE] } } });
    if (live >= limits.maxConcurrentRuns) throw new AppLimitError('APP_RUN_LIMIT', { kind: 'concurrent', limit: limits.maxConcurrentRuns });
    const since = await this.dayStart(userId);
    const today = await db.run.aggregate({ where: { clientId: client.clientId, createdAt: { gte: since } }, _count: { _all: true }, _sum: { costUsd: true } });
    if (today._count._all >= limits.dailyRunLimit) throw new AppLimitError('APP_RUN_LIMIT', { kind: 'daily', limit: limits.dailyRunLimit });
    if (limits.dailyCostLimitUsd !== null && Number(today._sum.costUsd ?? 0) >= limits.dailyCostLimitUsd) throw new AppLimitError('APP_COST_LIMIT', { limit: limits.dailyCostLimitUsd });

    const { paused: _p, ...rest } = limits;
    return { appLimits: { ...rest, clientId: client.clientId, clientName: client.clientName, appliedPolicyId: policyOverride }, policyOverride };
  }

  /**
   * After a run from an app committed: `app.first_run` (off by default) for
   * the first run of a connection. Never fails the caller.
   */
  async afterStart(userId: string, client: RequestClient, run: { id: string; goal: string }): Promise<void> {
    if (!client.clientId) return;
    try {
      // Claim the first run of this connection: only one request wins.
      const claimed = await this.db(userId).connectedAppSettings.updateMany({ where: { clientId: client.clientId, firstRunAt: null }, data: { firstRunAt: this.clock() } });
      if (claimed.count === 0) {
        const exists = await this.row(userId, client.clientId);
        if (exists) return;
        await this.db(userId).connectedAppSettings.create({ data: { userId, clientId: client.clientId, firstRunAt: this.clock() } }).catch(() => undefined);
      }
      await this.notifications?.notify(APP_FIRST_RUN_EVENT, userId, {
        clientId: client.clientId,
        appName: friendlyAppName(client.clientName),
        runId: run.id,
        goal: run.goal.slice(0, 300),
      });
    } catch (e) {
      this.log.warn(`app.first_run for run ${run.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---- The page ----

  /** The user's connected apps (their active grants), with limits and 30-day usage. */
  async list(userId: string): Promise<ConnectedAppView[]> {
    const grants = await this.prisma.oAuthGrant.findMany({
      where: { userId, revokedAt: null },
      include: { client: { select: { id: true, name: true, host: true, logoUri: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
    });
    // One app per client: its newest grant.
    const byClient = new Map<string, (typeof grants)[number]>();
    for (const g of grants) if (!byClient.has(g.clientId)) byClient.set(g.clientId, g);
    const ids = [...byClient.keys()];
    if (ids.length === 0) return [];
    const [rows, ceilings, usage] = await Promise.all([this.db(userId).connectedAppSettings.findMany({ where: { clientId: { in: ids } } }), this.ceilings(), this.usage(userId, ids)]);
    const rowOf = new Map(rows.map((r) => [r.clientId, r]));
    return ids.map((id) => {
      const g = byClient.get(id)!;
      const name = clientLabel(g.client);
      return {
        clientId: id,
        grantId: g.id,
        name,
        displayName: friendlyAppName(name),
        selfName: g.client.name || null,
        host: g.client.host && g.client.host !== 'loopback' ? g.client.host : null,
        logoUri: g.client.logoUri,
        verified: true,
        removed: false,
        connectedAt: g.createdAt.toISOString(),
        lastUsedAt: g.lastUsedAt?.toISOString() ?? null,
        scopes: scopeViews(g.scopes),
        limits: clampLimits(limitsOf(rowOf.get(id) ?? null), ceilings),
        usage: usage.get(id)!,
      };
    });
  }

  /** One app: connected (an active grant), or known from its settings or runs (then `grantId` is null). */
  async get(userId: string, clientId: string): Promise<ConnectedAppView> {
    const listed = (await this.list(userId)).find((a) => a.clientId === clientId);
    if (listed) return listed;
    const [row, lastRun, client] = await Promise.all([
      this.row(userId, clientId),
      this.db(userId).run.findFirst({ where: { clientId }, orderBy: { createdAt: 'desc' }, select: { clientName: true } }),
      this.prisma.oAuthClient.findUnique({ where: { id: clientId }, select: { name: true, host: true, logoUri: true } }),
    ]);
    if (!row && !lastRun) throw new NotFoundException({ code: 'APP_NOT_FOUND', message: 'No AI app with that id is connected to your account' });
    const name = client ? clientLabel(client) : (lastRun?.clientName ?? 'Removed app');
    return {
      clientId,
      grantId: null,
      name,
      displayName: friendlyAppName(name),
      selfName: client?.name ?? null,
      host: client?.host && client.host !== 'loopback' ? client.host : null,
      logoUri: client?.logoUri ?? null,
      verified: Boolean(client),
      removed: !client,
      connectedAt: null,
      lastUsedAt: null,
      scopes: [],
      limits: clampLimits(limitsOf(row), await this.ceilings()),
      usage: (await this.usage(userId, [clientId])).get(clientId)!,
    };
  }

  /** Change an app's limits (creating its row). Only an app the user connected; a limit above the deployment ceiling is a 400. */
  async patch(userId: string, clientId: string, patch: Partial<AppLimits>): Promise<AppLimits> {
    const [grant, row] = await Promise.all([this.prisma.oAuthGrant.findFirst({ where: { userId, clientId }, select: { id: true } }), this.row(userId, clientId)]);
    if (!grant && !row) throw new NotFoundException({ code: 'APP_NOT_FOUND', message: 'No AI app with that id is connected to your account' });
    const ceilings = await this.ceilings();
    const invalid = (field: string, message: string) => new BadRequestException({ code: 'VALIDATION_ERROR', message: `${field}: ${message}`, details: { issues: [{ path: [field], message }] } });
    if (patch.maxConcurrentRuns !== undefined && patch.maxConcurrentRuns > ceilings.maxConcurrentRunsPerApp) throw invalid('maxConcurrentRuns', `at most ${ceilings.maxConcurrentRunsPerApp} (the deployment's limit)`);
    if (patch.dailyRunLimit !== undefined && patch.dailyRunLimit > ceilings.maxDailyRunsPerApp) throw invalid('dailyRunLimit', `at most ${ceilings.maxDailyRunsPerApp} (the deployment's limit)`);
    if (patch.policyId) await this.policies?.assertAssignable(userId, patch.policyId);
    for (const p of patch.allowedPolicyIds ?? []) await this.policies?.assertAssignable(userId, p, 'allowedPolicyIds');
    const current = limitsOf(row);
    const next = { ...current, ...patch };
    if (next.policyId && next.allowedPolicyIds.length > 0 && !next.allowedPolicyIds.includes(next.policyId)) throw invalid('policyId', 'must be one of the allowed policies');
    const data = {
      policyId: next.policyId,
      allowedPolicyIds: [...new Set(next.allowedPolicyIds)],
      allowedDomains: [...new Set(next.allowedDomains.map((d) => d.toLowerCase()))],
      maxConcurrentRuns: next.maxConcurrentRuns,
      dailyRunLimit: next.dailyRunLimit,
      dailyCostLimitUsd: next.dailyCostLimitUsd === null ? null : new Prisma.Decimal(next.dailyCostLimitUsd),
      confirmPurchases: next.confirmPurchases,
      confirmSensitiveActions: next.confirmSensitiveActions,
      allowSavedLogins: next.allowSavedLogins,
      allowSavedIdentity: next.allowSavedIdentity,
      allowSavedCards: next.allowSavedCards,
      allowConnections: next.allowConnections,
      paused: next.paused,
    };
    const saved = row
      ? await this.db(userId).connectedAppSettings.update({ where: { id: row.id }, data })
      : await this.db(userId).connectedAppSettings.create({ data: { ...data, userId, clientId } });
    this.log.log(`app settings user=${userId} client=${clientId} changed=[${Object.keys(patch).join(',')}]`);
    // The audit trail (#465): which limits changed (their names, and pause), never their values otherwise.
    await this.activity?.record({
      userId,
      event: 'app_settings',
      credentialKind: 'jwt',
      clientId,
      outcome: 'ok',
      detail: { changed: Object.keys(patch).sort(), ...(patch.paused !== undefined ? { paused: patch.paused } : {}), ...(patch.confirmSensitiveActions !== undefined ? { confirmSensitiveActions: patch.confirmSensitiveActions } : {}), ...(patch.allowSavedLogins !== undefined ? { allowSavedLogins: patch.allowSavedLogins } : {}), ...(patch.allowSavedIdentity !== undefined ? { allowSavedIdentity: patch.allowSavedIdentity } : {}), ...(patch.allowSavedCards !== undefined ? { allowSavedCards: patch.allowSavedCards } : {}), ...(patch.allowConnections !== undefined ? { allowConnections: patch.allowConnections } : {}) },
    });
    return clampLimits(limitsOf(saved), ceilings);
  }

  /** 30-day usage, today's counters and live runs per app, from `runs` (two grouped reads). */
  async usage(userId: string, clientIds: string[]): Promise<Map<string, ConnectedAppView['usage']>> {
    const now = this.clock();
    const db = this.db(userId);
    const since30 = new Date(now.getTime() - 30 * DAY_MS);
    const today = await this.dayStart(userId);
    const [month, day, live] = await Promise.all([
      db.run.groupBy({ by: ['clientId', 'costKnown'], where: { clientId: { in: clientIds }, createdAt: { gte: since30 } }, _count: { _all: true }, _sum: { costUsd: true }, _max: { createdAt: true } }),
      db.run.groupBy({ by: ['clientId'], where: { clientId: { in: clientIds }, createdAt: { gte: today } }, _count: { _all: true }, _sum: { costUsd: true } }),
      db.run.groupBy({ by: ['clientId'], where: { clientId: { in: clientIds }, status: { in: [...LIVE] } }, _count: { _all: true } }),
    ]);
    const lastAny = await db.run.groupBy({ by: ['clientId'], where: { clientId: { in: clientIds } }, _max: { createdAt: true } });
    const out = new Map<string, ConnectedAppView['usage']>();
    for (const id of clientIds) {
      const m = month.filter((g) => g.clientId === id);
      const d = day.find((g) => g.clientId === id);
      const last = lastAny.find((g) => g.clientId === id)?._max.createdAt ?? null;
      out.set(id, {
        runs30d: m.reduce((n, g) => n + g._count._all, 0),
        costUsd30d: Math.round(m.reduce((n, g) => n + Number(g._sum.costUsd ?? 0), 0) * 1e6) / 1e6,
        costKnown: m.every((g) => g.costKnown),
        lastRunAt: last ? last.toISOString() : null,
        liveRuns: live.find((g) => g.clientId === id)?._count._all ?? 0,
        runsToday: d?._count._all ?? 0,
        costTodayUsd: Math.round(Number(d?._sum.costUsd ?? 0) * 1e6) / 1e6,
      });
    }
    return out;
  }
}
