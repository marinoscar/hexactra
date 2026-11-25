// The Home summary (#430): what needs the person, what is running, what runs
// next, what just happened and whether the machines are up, in one request.
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import { addDaysToDateKey, zonedDateKey, zonedDayStart } from '@marinoscar/platform-contract/timezone';

import type { FleetHost } from '../fleet/fleet.schemas';
import { FleetService } from '../fleet/fleet.service';
import { PrismaService } from '../prisma/prisma.service';
import { readEffectiveBudget, runBudgetView, BUDGET_KEYS } from '../runner/budget';
import { describeCron } from '../schedules/cron-describe';
import { NOT_BENCHMARK_RUN_SQL } from '../tasks/runs.query';
import { BUDGET_STOP_REASONS } from '../tasks/runs.schemas';
import { FAILING_AFTER } from '../tasks/task-list.schemas';
import './home.metrics';

/** How many rows each block carries at most. */
export const HOME_LIMITS = { needsYou: 3, liveRuns: 6, upcoming: 5, recentRuns: 8, hosts: 6 } as const;
/** How long the summary waits for the fabric before answering with the last known hosts. */
export const FLEET_TIMEOUT_MS = 1_500;
/** The week block covers today and the six days before it. */
const WEEK_DAYS = 7;
/** Long text is cut: Home shows one or two lines of it. */
const TEXT_MAX = 300;

/** What a live run is doing, without its arguments or its target: Home shows the phase and the action's name only. */
export interface HomeActivity {
  phase: string;
  action: string | null;
  reason: string | null;
  startedAt: string | null;
  note: string | null;
}

export interface HomeQuestion {
  questionId: string;
  runId: string | null;
  kind: string;
  input: string;
  prompt: string;
  risk: 'low' | 'high' | null;
  expiresAt: Date;
  createdAt: Date;
  /** The goal of the run that asked; null for a free-standing question. */
  goal: string | null;
}

export interface HomeLiveRun {
  id: string;
  taskId: string | null;
  taskName: string | null;
  goal: string;
  status: string;
  activity: HomeActivity | null;
  stepCount: number;
  startedAt: Date | null;
  hostId: string | null;
  /** Null when the caller may not read the fleet, or the host is not in the last list read. */
  hostName: string | null;
  policyName: string | null;
  currentTier: string | null;
  /** The tier the policy starts on: the run has escalated when `currentTier` differs. */
  startTier: string | null;
  /** The highest percent among the run's limited budgets; null when every budget is unlimited. */
  budgetPercent: number | null;
  /** The percent at which the policy warns; null with `budgetPercent`. */
  budgetWarnPercent: number | null;
}

export interface HomeRecentRun {
  id: string;
  taskId: string | null;
  taskName: string | null;
  goal: string;
  status: string;
  trigger: string;
  /** Where the run was started from (#464). */
  origin: string;
  /** The AI app that started it; null for any other caller. */
  client: { id: string | null; name: string | null; verified: boolean } | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  stepCount: number;
  stopReason: string | null;
  /** Null for a run that made no model call. */
  costUsd: number | null;
  costKnown: boolean;
  /** The first line of a failed run's error, as `GET /runs` returns it; null otherwise. */
  error: string | null;
}

export interface HomeSummary {
  generatedAt: Date;
  timezone: string;
  needsYou: { count: number; items: HomeQuestion[] } | null;
  /** `running`: how many of `count` are running (the rest wait for a person or a machine). */
  liveRuns: { count: number; running: number; items: HomeLiveRun[] } | null;
  upcoming: {
    items: { scheduleId: string; taskId: string; taskName: string; nextRunAt: Date; description: string; timezone: string }[];
    pausedCount: number;
    failingCount: number;
  } | null;
  recentRuns: { items: HomeRecentRun[] } | null;
  week: {
    totals: { succeeded: number; failed: number; cancelled: number; successRate: number | null; costUsd: number | null; costKnown: boolean; budgetStops: number; stalled: number };
    series: { date: string; succeeded: number; failed: number; cancelled: number; costUsd: number | null }[];
  } | null;
  fleet: {
    total: number;
    online: number;
    disabled: number;
    /** Profiles, across every host, that need the owner to sign in (signed out or expired; E48.3). A count only, never an email. */
    needsSignin: number;
    stale: boolean;
    hosts: { id: string; name: string; online: boolean; draining: boolean; mode: FleetHost['mode']; needsSignin: number }[];
  } | null;
  counts: { tasks: number | null; runs: number | null };
}

export interface HomeSummaryInput {
  userId: string;
  /** The caller's permissions: a block is built only when its permission is here. */
  permissions: readonly string[];
  /** The zone the week's days are bucketed in (the profile time zone). */
  timezone: string;
  now?: Date;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const round = (v: number, places: number): number => Math.round(v * 10 ** places) / 10 ** places;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** `runs.activity` without `args` and `target`. */
export function homeActivity(value: unknown): HomeActivity | null {
  if (!value || typeof value !== 'object') return null;
  const a = value as Record<string, unknown>;
  if (typeof a.phase !== 'string') return null;
  return { phase: a.phase, action: str(a.action), reason: str(a.reason)?.slice(0, TEXT_MAX) ?? null, startedAt: str(a.startedAt), note: str(a.note)?.slice(0, TEXT_MAX) ?? null };
}

/**
 * Builds the Home summary in at most six statements, whatever the account
 * holds: the pending questions, the live runs, the finished runs, the week,
 * the next firings, and one row of counts. Each statement carries the user id
 * as a bound parameter and joins only rows of the same user (the form
 * `TaskSummaryService` uses: the joins and window counts are not expressible
 * through `forUser` in one statement). Nothing here reads `transcript`,
 * `policy_snapshot` beyond three named fields, a question's `response`, or a
 * viewer URL.
 */
@Injectable()
export class HomeService {
  private readonly log = new Logger(HomeService.name);
  /** The last host list the fabric answered with (the fleet is the deployment's, not a user's). */
  private lastHosts: FleetHost[] | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly fleet: FleetService,
    @Optional() private readonly metrics?: AppMetricsService,
  ) {}

  async summary(input: HomeSummaryInput): Promise<HomeSummary> {
    const started = Date.now();
    const now = input.now ?? new Date();
    const can = (p: string) => input.permissions.includes(p);
    const runs = can('runs:read');
    const tasks = can('tasks:read');
    const { userId, timezone } = input;

    const [needsYou, live, recentRuns, week, upcoming, account, fleet] = await Promise.all([
      runs ? this.needsYou(userId, now) : null,
      runs ? this.liveRuns(userId, now) : null,
      runs ? this.recentRuns(userId) : null,
      runs ? this.week(userId, timezone, now) : null,
      tasks ? this.upcoming(userId) : null,
      runs || tasks ? this.account(userId, tasks, runs) : null,
      can('fleet:read') ? this.fleetBlock() : null,
    ]);

    const hostNames = new Map((fleet?.all ?? []).map((h) => [h.id, h.name]));
    const summary: HomeSummary = {
      generatedAt: now,
      timezone,
      needsYou,
      liveRuns: live && { count: live.count, running: live.running, items: live.items.map((r) => ({ ...r, hostName: (r.hostId && hostNames.get(r.hostId)) || null })) },
      upcoming: upcoming && { items: upcoming, pausedCount: account?.paused ?? 0, failingCount: account?.failing ?? 0 },
      recentRuns: recentRuns && { items: recentRuns },
      week,
      fleet: fleet && fleet.block,
      counts: { tasks: tasks ? (account?.tasks ?? 0) : null, runs: runs ? (account?.runs ?? 0) : null },
    };
    const ms = Date.now() - started;
    this.metrics?.record('homeSummaryDuration', ms / 1000);
    const blocks = (['needsYou', 'liveRuns', 'upcoming', 'recentRuns', 'week', 'fleet'] as const).filter((k) => summary[k] !== null);
    this.log.debug(`home summary user=${userId} blocks=[${blocks.join(',')}] ms=${ms}`);
    return summary;
  }

  /** The unanswered, unexpired questions: the ones that expire first, and how many there are. */
  private async needsYou(userId: string, now: Date): Promise<NonNullable<HomeSummary['needsYou']>> {
    const rows = await this.prisma.$queryRaw<(HomeQuestion & { total: number })[]>(Prisma.sql`
      SELECT q.id::text AS "questionId", q.run_id::text AS "runId", q.kind, q.input::text AS input,
             left(q.prompt, ${TEXT_MAX}) AS prompt, q.risk, q.expires_at AS "expiresAt", q.created_at AS "createdAt",
             left(r.goal, ${TEXT_MAX}) AS goal, (count(*) OVER ())::int AS total
      FROM questions q
      LEFT JOIN runs r ON r.id = q.run_id AND r.user_id = q.owner_user_id
      WHERE q.owner_user_id = ${userId}::uuid AND q.status = 'pending' AND q.expires_at > ${now}
      ORDER BY q.expires_at ASC, q.id ASC
      LIMIT ${HOME_LIMITS.needsYou}`);
    return {
      count: rows[0]?.total ?? 0,
      items: rows.map(({ total: _total, ...q }) => ({ ...q, risk: q.risk === 'low' || q.risk === 'high' ? q.risk : null })),
    };
  }

  /** The runs that are not finished: running first, then waiting for a person, then queued; newest first within each. */
  private async liveRuns(userId: string, now: Date): Promise<{ count: number; running: number; items: Omit<HomeLiveRun, 'hostName'>[] }> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        taskId: string | null;
        taskName: string | null;
        goal: string;
        status: string;
        activity: unknown;
        stepCount: number;
        startedAt: Date | null;
        hostId: string | null;
        policyName: string | null;
        currentTier: string | null;
        startTier: string | null;
        effectiveBudget: unknown;
        modelCalls: number;
        inputTokens: number;
        outputTokens: number;
        costUsd: unknown;
        costKnown: boolean;
        activeMs: number;
        activeSince: Date | null;
        total: number;
        running: number;
      }[]
    >(Prisma.sql`
      SELECT r.id::text AS id, r.task_id::text AS "taskId", t.name AS "taskName", left(r.goal, ${TEXT_MAX}) AS goal,
             r.status::text AS status, r.activity, r.step_count AS "stepCount", r.started_at AS "startedAt", r.host_id::text AS "hostId",
             r.policy_snapshot->>'name' AS "policyName", r.current_tier AS "currentTier",
             r.policy_snapshot->'spec'->'models'->>'startTier' AS "startTier",
             r.policy_snapshot->'effectiveBudget' AS "effectiveBudget",
             r.model_calls AS "modelCalls", r.input_tokens AS "inputTokens", r.output_tokens AS "outputTokens",
             r.cost_usd::float8 AS "costUsd", r.cost_known AS "costKnown", r.active_ms AS "activeMs", r.active_since AS "activeSince",
             (count(*) OVER ())::int AS total, (count(*) FILTER (WHERE r.status = 'running') OVER ())::int AS running
      FROM runs r
      LEFT JOIN tasks t ON t.id = r.task_id AND t.user_id = r.user_id
      WHERE r.user_id = ${userId}::uuid AND r.status IN ('queued', 'running', 'waiting_human', 'paused') AND ${NOT_BENCHMARK_RUN_SQL}
      ORDER BY CASE r.status WHEN 'running' THEN 0 WHEN 'waiting_human' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END, r.created_at DESC, r.id DESC
      LIMIT ${HOME_LIMITS.liveRuns}`);
    return {
      count: rows[0]?.total ?? 0,
      running: rows[0]?.running ?? 0,
      items: rows.map((r) => {
        // The run's stored budget, read the way the run API and the stream read it; nothing is recomputed here.
        const effective = readEffectiveBudget(r.effectiveBudget);
        const view = effective ? runBudgetView(effective, { ...r, costUsd: num(r.costUsd) }, now.getTime()) : null;
        const percents = view ? BUDGET_KEYS.flatMap((k) => (view.percent[k] === null ? [] : [view.percent[k]!])) : [];
        const budgetPercent = percents.length > 0 ? Math.max(...percents) : null;
        return {
          id: r.id,
          taskId: r.taskId,
          taskName: r.taskName,
          goal: r.goal,
          status: r.status,
          activity: r.status === 'running' ? homeActivity(r.activity) : null,
          stepCount: r.stepCount,
          startedAt: r.startedAt,
          hostId: r.hostId,
          policyName: r.policyName,
          currentTier: r.currentTier ?? r.startTier,
          startTier: r.startTier,
          budgetPercent,
          budgetWarnPercent: budgetPercent === null ? null : view!.effective.warnAtPercent,
        };
      }),
    };
  }

  /** The finished runs, the most recently finished first. */
  private async recentRuns(userId: string): Promise<HomeRecentRun[]> {
    const rows = await this.prisma.$queryRaw<(Omit<HomeRecentRun, 'costUsd' | 'client'> & { costUsd: unknown; modelCalls: number; clientId: string | null; clientName: string | null })[]>(Prisma.sql`
      SELECT r.id::text AS id, r.task_id::text AS "taskId", t.name AS "taskName", left(r.goal, ${TEXT_MAX}) AS goal,
             r.status::text AS status, r.trigger::text AS trigger, r.origin::text AS origin,
             r.client_id::text AS "clientId", r.client_name AS "clientName", r.created_at AS "createdAt", r.started_at AS "startedAt",
             r.finished_at AS "finishedAt", r.step_count AS "stepCount", r.stop_reason::text AS "stopReason",
             r.cost_usd::float8 AS "costUsd", r.cost_known AS "costKnown", r.model_calls AS "modelCalls",
             CASE WHEN r.status = 'failed' THEN left(split_part(r.error, E'\n', 1), ${TEXT_MAX}) END AS error
      FROM runs r
      LEFT JOIN tasks t ON t.id = r.task_id AND t.user_id = r.user_id
      WHERE r.user_id = ${userId}::uuid AND r.status IN ('succeeded', 'failed', 'cancelled') AND ${NOT_BENCHMARK_RUN_SQL}
      ORDER BY COALESCE(r.finished_at, r.created_at) DESC, r.id DESC
      LIMIT ${HOME_LIMITS.recentRuns}`);
    return rows.map(({ modelCalls, costUsd, clientId, clientName, ...r }) => ({
      ...r,
      client: clientId || clientName ? { id: clientId, name: clientName, verified: clientId !== null } : null,
      error: str(r.error),
      costUsd: modelCalls > 0 ? round(num(costUsd), 6) : null,
    }));
  }

  /** The runs created in the last seven calendar days of `timezone`, per day; a day without runs is a row of zeros. */
  private async week(userId: string, timezone: string, now: Date): Promise<NonNullable<HomeSummary['week']>> {
    const today = zonedDateKey(now, timezone);
    const first = addDaysToDateKey(today, -(WEEK_DAYS - 1));
    const from = zonedDayStart(first, timezone);
    const rows = await this.prisma.$queryRaw<{ day: string; succeeded: number; failed: number; cancelled: number; cost: unknown; unpriced: number; budgetStops: number; stalled: number }[]>(Prisma.sql`
      SELECT to_char(r.created_at AT TIME ZONE ${timezone}::text, 'YYYY-MM-DD') AS day,
             (count(*) FILTER (WHERE r.status = 'succeeded'))::int AS succeeded,
             (count(*) FILTER (WHERE r.status = 'failed'))::int AS failed,
             (count(*) FILTER (WHERE r.status = 'cancelled'))::int AS cancelled,
             (sum(r.cost_usd) FILTER (WHERE r.cost_usd > 0))::float8 AS cost,
             (count(*) FILTER (WHERE NOT r.cost_known))::int AS unpriced,
             (count(*) FILTER (WHERE r.stop_reason::text = ANY(${[...BUDGET_STOP_REASONS]}::text[])))::int AS "budgetStops",
             (count(*) FILTER (WHERE r.stop_reason::text = 'stalled'))::int AS stalled
      FROM runs r
      WHERE r.user_id = ${userId}::uuid AND r.created_at >= ${from} AND ${NOT_BENCHMARK_RUN_SQL}
      GROUP BY 1`);
    const byDay = new Map(rows.map((d) => [d.day, d]));
    const series: NonNullable<HomeSummary['week']>['series'] = [];
    const totals = { succeeded: 0, failed: 0, cancelled: 0, budgetStops: 0, stalled: 0, unpriced: 0 };
    let cost: number | null = null;
    for (let i = 0; i < WEEK_DAYS; i++) {
      const date = addDaysToDateKey(first, i);
      const d = byDay.get(date);
      const dayCost = d?.cost === null || d?.cost === undefined ? null : round(Number(d.cost), 6);
      series.push({ date, succeeded: d?.succeeded ?? 0, failed: d?.failed ?? 0, cancelled: d?.cancelled ?? 0, costUsd: dayCost });
      if (!d) continue;
      totals.succeeded += d.succeeded;
      totals.failed += d.failed;
      totals.cancelled += d.cancelled;
      totals.budgetStops += d.budgetStops;
      totals.stalled += d.stalled;
      totals.unpriced += d.unpriced;
      if (dayCost !== null) cost = (cost ?? 0) + dayCost;
    }
    const decided = totals.succeeded + totals.failed;
    return {
      totals: {
        succeeded: totals.succeeded,
        failed: totals.failed,
        cancelled: totals.cancelled,
        successRate: decided > 0 ? round(totals.succeeded / decided, 4) : null,
        costUsd: cost === null ? null : round(cost, 6),
        costKnown: totals.unpriced === 0,
        budgetStops: totals.budgetStops,
        stalled: totals.stalled,
      },
      series,
    };
  }

  /** The next firings of the enabled schedules. */
  private async upcoming(userId: string): Promise<NonNullable<HomeSummary['upcoming']>['items']> {
    const rows = await this.prisma.$queryRaw<{ scheduleId: string; taskId: string; taskName: string; nextRunAt: Date; cron: string; timezone: string }[]>(Prisma.sql`
      SELECT s.id::text AS "scheduleId", s.task_id::text AS "taskId", t.name AS "taskName", s.next_run_at AS "nextRunAt", s.cron, s.timezone
      FROM task_schedules s
      JOIN tasks t ON t.id = s.task_id AND t.user_id = s.user_id
      WHERE s.user_id = ${userId}::uuid AND s.enabled AND s.next_run_at IS NOT NULL
      ORDER BY s.next_run_at ASC, s.id ASC
      LIMIT ${HOME_LIMITS.upcoming}`);
    return rows.map(({ cron, ...s }) => ({ ...s, description: describeCron(cron) }));
  }

  /**
   * How many tasks and runs the user has, and how many tasks are paused or
   * failing: the same two definitions as `GET /tasks?filter=paused|failing`
   * (`TaskSummaryService.list`), so the count equals the list the link opens.
   */
  private async account(userId: string, tasks: boolean, runs: boolean): Promise<{ tasks: number; runs: number; paused: number; failing: number }> {
    const runCount = runs ? Prisma.sql`(SELECT count(*) FROM runs r WHERE r.user_id = ${userId}::uuid AND ${NOT_BENCHMARK_RUN_SQL})::int` : Prisma.sql`0`;
    const taskCounts = tasks
      ? Prisma.sql`(
          SELECT json_build_object(
            'tasks', count(*),
            'paused', count(*) FILTER (WHERE sc.total > 0 AND sc.enabled_count = 0),
            'failing', count(*) FILTER (WHERE sc.max_failures >= ${FAILING_AFTER} OR lr.status = 'failed'))
          FROM tasks t
          LEFT JOIN LATERAL (
            SELECT count(*) AS total, count(*) FILTER (WHERE s.enabled) AS enabled_count, COALESCE(max(s.consecutive_failures), 0) AS max_failures
            FROM task_schedules s WHERE s.task_id = t.id AND s.user_id = t.user_id
          ) sc ON TRUE
          LEFT JOIN LATERAL (
            SELECT r.status FROM runs r WHERE r.task_id = t.id AND r.user_id = t.user_id AND ${NOT_BENCHMARK_RUN_SQL}
            ORDER BY r.created_at DESC, r.id DESC LIMIT 1
          ) lr ON TRUE
          WHERE t.user_id = ${userId}::uuid)`
      : Prisma.sql`NULL::json`;
    const rows = await this.prisma.$queryRaw<{ runs: number; t: { tasks: number; paused: number; failing: number } | null }[]>(Prisma.sql`SELECT ${runCount} AS runs, ${taskCounts} AS t`);
    const row = rows[0];
    return { runs: row?.runs ?? 0, tasks: num(row?.t?.tasks), paused: num(row?.t?.paused), failing: num(row?.t?.failing) };
  }

  /**
   * The hosts, from the fabric. A fabric that is slow or down never fails the
   * summary: after `FLEET_TIMEOUT_MS` the block is the last list this process
   * read, marked `stale`. A fabric that is not configured has no machines.
   */
  private async fleetBlock(): Promise<{ block: NonNullable<HomeSummary['fleet']>; all: FleetHost[] }> {
    let hosts: FleetHost[];
    let stale = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      hosts = await Promise.race([
        // A slow answer still becomes the last known list for the next summary.
        this.fleet.hosts().then((list) => (this.lastHosts = list)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('fleet lookup timed out')), FLEET_TIMEOUT_MS);
        }),
      ]);
    } catch (e) {
      const code = (e as { getResponse?: () => unknown }).getResponse?.() as { code?: string } | undefined;
      // No fabric connection at all: nothing can be out of date.
      stale = code?.code !== 'FABRIC_NOT_CONFIGURED';
      hosts = stale ? (this.lastHosts ?? []) : [];
      if (stale) this.log.debug(`home summary: fleet unavailable (${e instanceof Error ? e.message : 'error'}), answering with the last known hosts`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return {
      all: hosts,
      block: {
        total: hosts.length,
        online: hosts.filter((h) => h.online).length,
        disabled: hosts.filter((h) => h.draining).length,
        needsSignin: hosts.reduce((n, h) => n + profilesNeedingSignin(h), 0),
        stale,
        // Online first, then by name (the order the Fleet page lists them in).
        hosts: [...hosts]
          .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
          .slice(0, HOME_LIMITS.hosts)
          .map((h) => ({ id: h.id, name: h.name, online: h.online, draining: h.draining, mode: h.mode, needsSignin: profilesNeedingSignin(h) })),
      },
    };
  }
}

/** A host's profiles that need sign-in: signed out or expired, never `unknown` (docs/decisions/profile-signin-health.md). */
function profilesNeedingSignin(h: FleetHost): number {
  return (h.profiles ?? []).filter((p) => p.signin === 'signed_out' || p.signin === 'expired').length;
}
