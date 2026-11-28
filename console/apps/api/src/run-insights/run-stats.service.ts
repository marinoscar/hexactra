import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { builtinPolicy } from '../policies/builtin-policies';
import { PrismaService } from '../prisma/prisma.service';
import { PrismaSystemService } from '../prisma/prisma-system.service';
import { runWhereSql } from '../tasks/runs.query';
import { RUN_STATUSES, type RunFilter } from '../tasks/runs.schemas';
import type { RunStatus } from '../tasks/run-status';
import { RUN_STATS_MAX_RUNS, RUN_STATS_METRICS, emptyRawGroup, runStatsOf, type RawRunStatsGroup, type RunStats, type RunStatsGroupBy, type RunStatsMetric } from './run-stats';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Each measure as SQL over `r` (fixed text). A wall time needs both a start and an end; otherwise it is NULL and not counted. */
const MEASURE_SQL: Record<RunStatsMetric, Prisma.Sql> = {
  workingMs: Prisma.sql`r.active_ms::float8`,
  wallMs: Prisma.sql`CASE WHEN r.started_at IS NOT NULL AND r.finished_at IS NOT NULL THEN GREATEST(0, EXTRACT(EPOCH FROM (r.finished_at - r.started_at)) * 1000)::float8 END`,
  // Measured since E54.0: a run from before (0 with model calls) is unknown, not instant, so it is left out.
  modelMs: Prisma.sql`CASE WHEN r.model_ms > 0 THEN r.model_ms::float8 END`,
  steps: Prisma.sql`r.step_count::float8`,
  modelCalls: Prisma.sql`r.model_calls::float8`,
  inputTokens: Prisma.sql`r.input_tokens::float8`,
  cachedInputTokens: Prisma.sql`r.cached_input_tokens::float8`,
  outputTokens: Prisma.sql`r.output_tokens::float8`,
  totalTokens: Prisma.sql`(r.input_tokens::float8 + r.output_tokens::float8)`,
  costUsd: Prisma.sql`r.cost_usd::float8`,
};

const FINISHED_SQL = Prisma.sql`r.status IN ('succeeded', 'failed', 'cancelled')`;

/** The group key as SQL over `r`. Only the time zone is a value, and it is bound (and validated as an IANA id before). */
function keySql(groupBy: RunStatsGroupBy, timeZone: string): Prisma.Sql {
  switch (groupBy) {
    case 'none':
      return Prisma.sql`''`;
    case 'task':
      return Prisma.sql`COALESCE(r.task_id::text, 'none')`;
    case 'policy':
      return Prisma.sql`COALESCE(r.policy_ref, 'none')`;
    case 'stopReason':
      return Prisma.sql`COALESCE(r.stop_reason::text, 'none')`;
    case 'status':
      return Prisma.sql`r.status::text`;
    case 'trigger':
      return Prisma.sql`r.trigger::text`;
    case 'origin':
      return Prisma.sql`r.origin::text`;
    case 'tier':
      return Prisma.sql`COALESCE(r.current_tier, 'none')`;
    case 'user':
      return Prisma.sql`r.user_id::text`;
    case 'day':
      return Prisma.sql`to_char((r.created_at AT TIME ZONE ${timeZone})::date, 'YYYY-MM-DD')`;
    case 'week':
      // date_trunc('week') starts a week on Monday (ISO).
      return Prisma.sql`to_char(date_trunc('week', r.created_at AT TIME ZONE ${timeZone})::date, 'YYYY-MM-DD')`;
  }
}

/** The aggregates of one measure over the finished runs: count, sum, min, max, median (`percentile_cont`) and p90 (nearest rank). */
function measureAggregates(m: RunStatsMetric): Prisma.Sql {
  const v = MEASURE_SQL[m];
  const a = (suffix: string) => Prisma.raw(`"${m}_${suffix}"`);
  return Prisma.sql`
    count(${v}) FILTER (WHERE ${FINISHED_SQL})::int AS ${a('n')},
    sum(${v}) FILTER (WHERE ${FINISHED_SQL}) AS ${a('sum')},
    min(${v}) FILTER (WHERE ${FINISHED_SQL}) AS ${a('min')},
    max(${v}) FILTER (WHERE ${FINISHED_SQL}) AS ${a('max')},
    percentile_cont(0.5) WITHIN GROUP (ORDER BY ${v}) FILTER (WHERE ${FINISHED_SQL}) AS ${a('p50')},
    percentile_disc(0.9) WITHIN GROUP (ORDER BY ${v}) FILTER (WHERE ${FINISHED_SQL}) AS ${a('p90')}`;
}

type AggregateRow = Record<string, number | string | boolean | null> & { k: string; is_total: number };

/**
 * Run statistics (E53.1, #1069): one aggregate query over the user's runs, with the runs list's filter as SQL (`runWhereSql`, which
 * selects exactly what `runWhere` does). No model, no table, no cache. Reads numbers and grouping keys only: never the goal, the
 * result, the transcript or a step.
 */
@Injectable()
export class RunStatsService {
  private readonly log = new Logger(RunStatsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly system: PrismaSystemService,
  ) {}

  /** The caller's own runs. */
  async stats(userId: string, filter: RunFilter, groupBy: RunStatsGroupBy, timeZone: string, maxRuns = RUN_STATS_MAX_RUNS): Promise<RunStats> {
    return this.compute({ userId }, filter, groupBy, timeZone, maxRuns);
  }

  /**
   * Every user's runs (E53.2, #1070), for a route behind `run_stats:read_all`: through the system client (`admin-aggregate`), as
   * the AI usage Doctor check reads deployment totals. Aggregates only: task and policy groups are labelled by id, users by
   * display name; never a goal, a result or a step.
   */
  async statsAll(filter: Omit<RunFilter, 'q'>, groupBy: RunStatsGroupBy, timeZone: string, maxRuns = RUN_STATS_MAX_RUNS): Promise<RunStats> {
    return this.compute({ userId: null }, filter, groupBy, timeZone, maxRuns);
  }

  private async compute(scope: { userId: string | null }, filter: RunFilter, groupBy: RunStatsGroupBy, timeZone: string, maxRuns: number): Promise<RunStats> {
    const started = Date.now();
    if (scope.userId !== null && groupBy === 'user') throw new BadRequestException({ code: 'BAD_REQUEST', message: 'groupBy=user is for the admin statistics (GET /admin/runs/stats)' });
    const where = runWhereSql(scope.userId, filter);
    const db = scope.userId === null ? this.system.asSystem('admin-aggregate') : this.prisma;
    const [{ n: matched }] = await db.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT count(*)::int AS n FROM (SELECT 1 FROM runs r WHERE ${where} LIMIT ${maxRuns + 1}) x`);
    const truncated = matched > maxRuns;
    // Past the limit, the newest `maxRuns` (the runs list's order); otherwise every match, with no sort.
    const source = truncated
      ? Prisma.sql`(SELECT * FROM runs r WHERE ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ${maxRuns})`
      : Prisma.sql`(SELECT * FROM runs r WHERE ${where})`;
    const rows = await db.$queryRaw<AggregateRow[]>(Prisma.sql`
      SELECT g.k AS k, GROUPING(g.k)::int AS is_total,
        ${Prisma.join(RUN_STATUSES.map((s) => Prisma.sql`count(*) FILTER (WHERE r.status = ${s}::run_status)::int AS ${Prisma.raw(`"s_${s}"`)}`))},
        COALESCE(bool_and(r.cost_known) FILTER (WHERE ${FINISHED_SQL}), true) AS cost_known,
        ${Prisma.join(RUN_STATS_METRICS.map(measureAggregates))}
      FROM ${source} r
      CROSS JOIN LATERAL (SELECT ${keySql(groupBy, timeZone)} AS k) g
      GROUP BY GROUPING SETS ((g.k), ())`);
    const raw = rows.map(toRawGroup);
    const totalRow = rows.findIndex((r) => r.is_total === 1);
    const total = totalRow >= 0 ? raw[totalRow]! : emptyRawGroup();
    const groups = raw.filter((_, i) => i !== totalRow);
    const labels = scope.userId === null ? await this.adminLabels(groups.map((g) => g.key), groupBy) : await this.labels(scope.userId, groups.map((g) => g.key), groupBy);
    const result = runStatsOf({ total, groups, groupBy, timeZone, scanned: Math.min(matched, maxRuns), truncated, label: (k) => labels.get(k) });
    // Which filters were used, never their values: a goal search is the user's text.
    const used = Object.entries(filter)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    this.log.debug(`runs stats user=${scope.userId ?? 'all'} groupBy=${groupBy} filters=[${used.join(',')}] scanned=${result.scanned} truncated=${truncated} groups=${result.groups.length} ms=${Date.now() - started}`);
    return result;
  }

  /**
   * Labels across users: another person's task or own policy is their content, so only its id is shown; a built-in policy by name;
   * a user by display name, never an email (`User <first 8 of id>` when there is no name, or it looks like an address).
   */
  private async adminLabels(keys: readonly string[], groupBy: RunStatsGroupBy): Promise<Map<string, string>> {
    const out = new Map<string, string>([['none', groupBy === 'task' ? 'No task' : groupBy === 'policy' ? 'No policy yet' : 'None']]);
    const ids = keys.filter((k) => UUID.test(k));
    if (groupBy === 'task') for (const id of ids) out.set(id, `Task ${id.slice(0, 8)}`);
    if (groupBy === 'policy') for (const k of keys) if (k !== 'none') out.set(k, builtinPolicy(k)?.name ?? `Policy ${k.slice(0, 8)}`);
    if (groupBy === 'user' && ids.length) {
      const users = (await this.system.asSystem('admin-aggregate').user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, providerDisplayName: true } })) as { id: string; displayName: string | null; providerDisplayName: string | null }[];
      const byId = new Map(users.map((u) => [u.id, u]));
      for (const id of ids) {
        const u = byId.get(id);
        const name = (u?.displayName ?? u?.providerDisplayName ?? '').trim();
        out.set(id, name && !name.includes('@') ? name.slice(0, 80) : `User ${id.slice(0, 8)}`);
      }
    }
    return out;
  }

  /** Task and policy names for their groups: the owner's own rows only (through `forUser`). */
  private async labels(userId: string, keys: readonly string[], groupBy: RunStatsGroupBy): Promise<Map<string, string>> {
    const out = new Map<string, string>([['none', groupBy === 'task' ? 'No task' : groupBy === 'policy' ? 'No policy yet' : 'None']]);
    const db = this.prisma.forUser({ userId });
    const ids = keys.filter((k) => UUID.test(k));
    if (groupBy === 'task' && ids.length) {
      for (const t of await db.task.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })) out.set(t.id, t.name);
    }
    if (groupBy === 'policy') {
      for (const k of keys) {
        const builtin = builtinPolicy(k);
        if (builtin) out.set(k, builtin.name);
      }
      if (ids.length) for (const p of await db.agentPolicy.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })) out.set(p.id, p.name);
      for (const id of ids) if (!out.has(id)) out.set(id, 'Deleted policy');
    }
    return out;
  }
}

function num(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function toRawGroup(row: AggregateRow): RawRunStatsGroup {
  const byStatus = Object.fromEntries(RUN_STATUSES.map((s) => [s, Number(row[`s_${s}`] ?? 0)])) as Record<RunStatus, number>;
  const metrics = Object.fromEntries(
    RUN_STATS_METRICS.map((m) => [m, { n: Number(row[`${m}_n`] ?? 0), sum: num(row[`${m}_sum`]), min: num(row[`${m}_min`]), p50: num(row[`${m}_p50`]), p90: num(row[`${m}_p90`]), max: num(row[`${m}_max`]) }]),
  ) as RawRunStatsGroup['metrics'];
  return { key: row.k ?? '', byStatus, costKnown: row.cost_known !== false, metrics };
}
