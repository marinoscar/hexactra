import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { addDaysToDateKey, zonedDateKey, zonedDayStart } from '@marinoscar/platform-contract/timezone';
import { Prisma, type Task } from '@prisma/client';

import '../schedules/schedules.errors';
import { PolicyResolver } from '../policies/policy.resolver';
import { PrismaService } from '../prisma/prisma.service';
import { describeCron } from '../schedules/cron-describe';
import { averageUsd, NO_SPEND, SPEND_WINDOW_DAYS, type TaskSpend } from './run-cost';
import { FAILING_AFTER, type ListTasksDto, type TaskSort } from './task-list.schemas';

const DAY_MS = 86_400_000;
/** The page size of `envelope=1` when `limit` is left out. */
const DEFAULT_PAGE = 50;

/** One schedule in a task's summary. */
export interface TaskSummarySchedule {
  id: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  concurrency: 'skip' | 'queue';
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  consecutiveFailures: number;
  description: string;
  policyId: string | null;
  /** Preset task parameter values (#552), by key; null for none. */
  inputs: Record<string, string> | null;
}

/** Schedule and run facts of one task (`include=summary`). */
export interface TaskSummary {
  schedules: TaskSummarySchedule[];
  /** `partial`: some schedules enabled, some not. */
  scheduleState: 'none' | 'active' | 'paused' | 'partial';
  /** The earliest next firing among the enabled schedules. */
  nextRunAt: Date | null;
  lastRun: { id: string; status: string; trigger: string; createdAt: Date; finishedAt: Date | null } | null;
  /** The newest queued, running or waiting run. */
  liveRunId: string | null;
  runCounts: { total: number; last7d: { succeeded: number; failed: number; cancelled: number } };
  /** The policy a run started now would use; null only when it could not be resolved. */
  policy: { id: string; name: string; builtin: boolean; isDefault: boolean } | null;
}

export type TaskWithSpend = Task & { spend30d: TaskSpend };
export type TaskWithSummary = TaskWithSpend & { summary: TaskSummary };

export interface TaskStats {
  days: number;
  timezone: string;
  totals: { runs: number; succeeded: number; failed: number; cancelled: number; successRate: number | null; costUsd: number | null; costKnown: boolean };
  avgDurationSeconds: number | null;
  p95DurationSeconds: number | null;
  avgSteps: number | null;
  avgCostPerSuccessUsd: number | null;
  series: { date: string; succeeded: number; failed: number; cancelled: number; costUsd: number | null }[];
  stopReasons: { reason: string; count: number }[];
}

/** What a cursor holds: the sort it belongs to, and either the last row's key or an offset. */
type Cursor = { s: TaskSort; c?: string; n?: string; i?: string; o?: number };

const KEYSET_SORTS: readonly TaskSort[] = ['created_desc', 'name_asc'];

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

function decodeCursor(raw: string, sort: TaskSort): Cursor {
  const bad = () => new BadRequestException({ code: 'INVALID_TASK_CURSOR', message: 'The cursor is not valid for this list; start again without it' });
  let c: Cursor;
  try {
    c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
  } catch {
    throw bad();
  }
  if (!c || typeof c !== 'object' || c.s !== sort) throw bad();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (sort === 'created_desc') {
    if (typeof c.c !== 'string' || Number.isNaN(Date.parse(c.c)) || typeof c.i !== 'string' || !uuid.test(c.i)) throw bad();
  } else if (sort === 'name_asc') {
    if (typeof c.n !== 'string' || typeof c.i !== 'string' || !uuid.test(c.i)) throw bad();
  } else if (typeof c.o !== 'number' || !Number.isInteger(c.o) || c.o < 0 || c.o > 1_000_000) {
    throw bad();
  }
  return c;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const round = (v: number | null, places: number): number | null => (v === null ? null : Math.round(v * 10 ** places) / 10 ** places);

/**
 * The task list with paging, search, filters and sorts, the per-task summary
 * and the per-task statistics (#424).
 *
 * A page costs a fixed number of queries whatever its size: the page of ids
 * (with the total), the task rows, their schedules, one aggregate over their
 * runs, one "newest run / newest live run" read, and two for the policies.
 * The raw SQL always carries the user id as a bound parameter; the rest goes
 * through `forUser`.
 */
@Injectable()
export class TaskSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PolicyResolver,
  ) {}

  private db(userId: string) {
    return this.prisma.forUser({ userId });
  }

  /**
   * One page of the user's tasks. `created_desc` and `name_asc` page by keyset
   * (no row is skipped or repeated when tasks are added or removed between
   * pages). The computed sorts (`last_run_desc`, `next_run_asc`, `spend_desc`)
   * page by an offset inside the cursor: their sort key changes whenever a run
   * starts or a schedule fires, so a keyset on it would be no more stable, and
   * a user has tens to low hundreds of tasks, so the offset scan is cheap.
   */
  async list(userId: string, q: ListTasksDto): Promise<{ items: (TaskWithSpend | TaskWithSummary)[]; nextCursor: string | null; total: number }> {
    const sort = q.sort;
    const limit = q.limit ?? (q.envelope ? DEFAULT_PAGE : undefined);
    const cursor = q.cursor ? decodeCursor(q.cursor, sort) : null;
    const since = new Date(Date.now() - SPEND_WINDOW_DAYS * DAY_MS);

    const where: Prisma.Sql[] = [Prisma.sql`t.user_id = ${userId}::uuid`];
    if (q.q) {
      // A bound parameter; `%`, `_` and `\` in the text match themselves.
      const like = `%${q.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      where.push(Prisma.sql`(t.name ILIKE ${like} OR t.goal ILIKE ${like})`);
    }
    if (q.policyId === 'default') where.push(Prisma.sql`t.policy_ref IS NULL`);
    else if (q.policyId) where.push(Prisma.sql`t.policy_ref = ${q.policyId}`);
    if (q.filter === 'scheduled') where.push(Prisma.sql`sc.enabled_count > 0`);
    if (q.filter === 'paused') where.push(Prisma.sql`sc.total > 0 AND sc.enabled_count = 0`);
    if (q.filter === 'unscheduled') where.push(Prisma.sql`sc.total = 0`);
    if (q.filter === 'failing') where.push(Prisma.sql`(sc.max_failures >= ${FAILING_AFTER} OR lr.status = 'failed')`);
    if (q.filter === 'never_run') where.push(Prisma.sql`lr.status IS NULL`);

    const order: Record<TaskSort, Prisma.Sql> = {
      created_desc: Prisma.sql`m.created_at DESC, m.id DESC`,
      name_asc: Prisma.sql`m.lname ASC, m.id ASC`,
      last_run_desc: Prisma.sql`m.last_run_at DESC NULLS LAST, m.created_at DESC, m.id DESC`,
      next_run_asc: Prisma.sql`m.next_run_at ASC NULLS LAST, m.created_at DESC, m.id DESC`,
      spend_desc: Prisma.sql`m.spend DESC, m.created_at DESC, m.id DESC`,
    };
    let after = Prisma.sql`TRUE`;
    if (cursor && sort === 'created_desc') after = Prisma.sql`(m.created_at, m.id) < (${cursor.c}::timestamptz, ${cursor.i}::uuid)`;
    if (cursor && sort === 'name_asc') after = Prisma.sql`(m.lname, m.id) > (${cursor.n}, ${cursor.i}::uuid)`;
    const offset = cursor?.o ?? 0;
    // One row more than the page tells whether another page follows.
    const window = limit !== undefined ? Prisma.sql`LIMIT ${limit + 1} OFFSET ${offset}` : Prisma.empty;

    const rows = await this.prisma.$queryRaw<{ total: number; id: string | null; c: string | null; lname: string | null }[]>(Prisma.sql`
      WITH m AS (
        SELECT t.id, t.created_at, lower(t.name) AS lname, lr.created_at AS last_run_at, sc.next_run_at, COALESCE(sp.cost, 0) AS spend
        FROM tasks t
        LEFT JOIN LATERAL (
          SELECT count(*) AS total,
                 count(*) FILTER (WHERE s.enabled) AS enabled_count,
                 min(s.next_run_at) FILTER (WHERE s.enabled) AS next_run_at,
                 COALESCE(max(s.consecutive_failures), 0) AS max_failures
          FROM task_schedules s WHERE s.task_id = t.id AND s.user_id = t.user_id
        ) sc ON TRUE
        LEFT JOIN LATERAL (
          SELECT r.status, r.created_at FROM runs r
          WHERE r.task_id = t.id AND r.user_id = t.user_id
          ORDER BY r.created_at DESC, r.id DESC LIMIT 1
        ) lr ON TRUE
        LEFT JOIN LATERAL (
          SELECT sum(r.cost_usd) AS cost FROM runs r
          WHERE r.task_id = t.id AND r.user_id = t.user_id AND r.created_at >= ${since}
        ) sp ON TRUE
        WHERE ${Prisma.join(where, ' AND ')}
      )
      SELECT n.total, p.id::text AS id, p.c, p.lname
      FROM (SELECT count(*)::int AS total FROM m) n
      LEFT JOIN LATERAL (
        SELECT m.id, m.created_at::text AS c, m.lname, row_number() OVER (ORDER BY ${order[sort]}) AS pos
        FROM m WHERE ${after}
        ORDER BY ${order[sort]} ${window}
      ) p ON TRUE
      ORDER BY p.pos`);

    const total = rows[0]?.total ?? 0;
    const page = rows.filter((r): r is { total: number; id: string; c: string; lname: string } => r.id !== null);
    const hasMore = limit !== undefined && page.length > limit;
    const shown = hasMore ? page.slice(0, limit) : page;
    const last = shown[shown.length - 1];
    let nextCursor: string | null = null;
    if (hasMore && last) {
      if (sort === 'created_desc') nextCursor = encodeCursor({ s: sort, c: last.c, i: last.id });
      else if (sort === 'name_asc') nextCursor = encodeCursor({ s: sort, n: last.lname, i: last.id });
      else nextCursor = encodeCursor({ s: sort, o: offset + shown.length });
    }

    const ids = shown.map((r) => r.id);
    const found = ids.length > 0 ? await this.db(userId).task.findMany({ where: { id: { in: ids } } }) : [];
    const byId = new Map(found.map((t) => [t.id, t]));
    const tasks = ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    const items = q.include === 'summary' ? await this.summarize(userId, tasks) : await this.withSpend(userId, tasks);
    return { items, nextCursor, total };
  }

  /** One task with its summary. 404 `TASK_NOT_FOUND` unless it is the user's. */
  async one(userId: string, id: string): Promise<TaskWithSummary> {
    const task = await this.db(userId).task.findFirst({ where: { id } });
    if (!task) throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'Task not found' });
    return (await this.summarize(userId, [task]))[0]!;
  }

  /** Per task: the run counts, the 7-day outcomes and the 30-day spend, in one query. */
  private async runFacts(userId: string, ids: string[]) {
    const now = Date.now();
    const rows = await this.prisma.$queryRaw<
      { taskId: string; total: number; succeeded7: number; failed7: number; cancelled7: number; runs30: number; cost30: unknown; unknown30: number; tokens30: unknown; succeeded30: number; successCost30: unknown }[]
    >(Prisma.sql`
      SELECT r.task_id::text AS "taskId",
             count(*)::int AS total,
             (count(*) FILTER (WHERE r.created_at >= ${new Date(now - 7 * DAY_MS)} AND r.status = 'succeeded'))::int AS succeeded7,
             (count(*) FILTER (WHERE r.created_at >= ${new Date(now - 7 * DAY_MS)} AND r.status = 'failed'))::int AS failed7,
             (count(*) FILTER (WHERE r.created_at >= ${new Date(now - 7 * DAY_MS)} AND r.status = 'cancelled'))::int AS cancelled7,
             (count(*) FILTER (WHERE r.created_at >= ${new Date(now - SPEND_WINDOW_DAYS * DAY_MS)}))::int AS runs30,
             (sum(r.cost_usd) FILTER (WHERE r.created_at >= ${new Date(now - SPEND_WINDOW_DAYS * DAY_MS)}))::float8 AS cost30,
             (count(*) FILTER (WHERE r.created_at >= ${new Date(now - SPEND_WINDOW_DAYS * DAY_MS)} AND NOT r.cost_known))::int AS unknown30,
             (sum(r.input_tokens::bigint + r.output_tokens::bigint) FILTER (WHERE r.created_at >= ${new Date(now - SPEND_WINDOW_DAYS * DAY_MS)}))::float8 AS tokens30,
             (count(*) FILTER (WHERE r.created_at >= ${new Date(now - SPEND_WINDOW_DAYS * DAY_MS)} AND r.status = 'succeeded'))::int AS succeeded30,
             (sum(r.cost_usd) FILTER (WHERE r.created_at >= ${new Date(now - SPEND_WINDOW_DAYS * DAY_MS)} AND r.status = 'succeeded'))::float8 AS "successCost30"
      FROM runs r
      WHERE r.user_id = ${userId}::uuid AND r.task_id = ANY(${ids}::uuid[])
      GROUP BY r.task_id`);
    return new Map(rows.map((r) => [r.taskId, r]));
  }

  /** Per task: its newest run, and its newest live run when there is one (two rows at most per task). */
  private async newestRuns(userId: string, ids: string[]) {
    const rows = await this.prisma.$queryRaw<{ taskId: string; live: boolean; id: string; status: string; trigger: string; createdAt: Date; finishedAt: Date | null }[]>(Prisma.sql`
      SELECT DISTINCT ON (r.task_id, (r.status IN ('queued', 'running', 'waiting_human')))
             r.task_id::text AS "taskId",
             (r.status IN ('queued', 'running', 'waiting_human')) AS live,
             r.id::text AS id, r.status::text AS status, r.trigger::text AS trigger,
             r.created_at AS "createdAt", r.finished_at AS "finishedAt"
      FROM runs r
      WHERE r.user_id = ${userId}::uuid AND r.task_id = ANY(${ids}::uuid[])
      ORDER BY r.task_id, (r.status IN ('queued', 'running', 'waiting_human')), r.created_at DESC, r.id DESC`);
    const out = new Map<string, { last: (typeof rows)[number] | null; live: (typeof rows)[number] | null }>();
    for (const r of rows) {
      const entry = out.get(r.taskId) ?? { last: null, live: null };
      if (r.live) entry.live = r;
      if (!entry.last || r.createdAt.getTime() > entry.last.createdAt.getTime()) entry.last = r;
      out.set(r.taskId, entry);
    }
    return out;
  }

  private spendOf(facts: { runs30: number; cost30: unknown; unknown30: number; tokens30: unknown; succeeded30: number; successCost30: unknown } | undefined): TaskSpend {
    if (!facts || facts.runs30 === 0) return NO_SPEND;
    // The same figures as `TasksService.spendByTask` (#400, #408), from the one aggregate.
    return {
      runs: facts.runs30,
      costUsd: num(facts.cost30),
      costKnown: facts.unknown30 === 0,
      tokens: num(facts.tokens30),
      succeeded: facts.succeeded30,
      avgSuccessCostUsd: averageUsd(num(facts.successCost30), facts.succeeded30),
    };
  }

  /** The tasks with `spend30d` only (a page asked for without `include=summary`). */
  private async withSpend(userId: string, tasks: Task[]): Promise<TaskWithSpend[]> {
    if (tasks.length === 0) return [];
    const facts = await this.runFacts(userId, tasks.map((t) => t.id));
    return tasks.map((t) => ({ ...t, spend30d: this.spendOf(facts.get(t.id)) }));
  }

  /** The tasks with `spend30d` and `summary`, in five queries whatever their number. */
  async summarize(userId: string, tasks: Task[]): Promise<TaskWithSummary[]> {
    if (tasks.length === 0) return [];
    const ids = tasks.map((t) => t.id);
    const [schedules, facts, newest, policies] = await Promise.all([
      this.db(userId).taskSchedule.findMany({ where: { taskId: { in: ids } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      this.runFacts(userId, ids),
      this.newestRuns(userId, ids),
      // A policy that cannot be read must not fail the list: `policy` is then null.
      this.resolver.forTasks(userId, tasks).catch(() => new Map<string, never>()),
    ]);
    const byTask = new Map<string, TaskSummarySchedule[]>();
    for (const s of schedules) {
      const list = byTask.get(s.taskId) ?? [];
      list.push({
        id: s.id,
        cron: s.cron,
        timezone: s.timezone,
        enabled: s.enabled,
        concurrency: s.concurrency,
        nextRunAt: s.nextRunAt,
        lastRunAt: s.lastRunAt,
        consecutiveFailures: s.consecutiveFailures,
        description: describeCron(s.cron),
        policyId: s.policyRef,
        inputs: (s.inputs as Record<string, string> | null) ?? null,
      });
      byTask.set(s.taskId, list);
    }
    return tasks.map((t) => {
      const own = byTask.get(t.id) ?? [];
      const enabled = own.filter((s) => s.enabled);
      const next = enabled.flatMap((s) => (s.nextRunAt ? [s.nextRunAt.getTime()] : []));
      const f = facts.get(t.id);
      const runs = newest.get(t.id);
      const resolved = policies.get(t.id);
      const summary: TaskSummary = {
        schedules: own,
        scheduleState: own.length === 0 ? 'none' : enabled.length === own.length ? 'active' : enabled.length === 0 ? 'paused' : 'partial',
        nextRunAt: next.length > 0 ? new Date(Math.min(...next)) : null,
        lastRun: runs?.last ? { id: runs.last.id, status: runs.last.status, trigger: runs.last.trigger, createdAt: runs.last.createdAt, finishedAt: runs.last.finishedAt } : null,
        liveRunId: runs?.live?.id ?? null,
        runCounts: { total: f?.total ?? 0, last7d: { succeeded: f?.succeeded7 ?? 0, failed: f?.failed7 ?? 0, cancelled: f?.cancelled7 ?? 0 } },
        policy: resolved ? { id: resolved.policy.id, name: resolved.policy.name, builtin: resolved.policy.builtin, isDefault: resolved.isDefault } : null,
      };
      return { ...t, spend30d: this.spendOf(f), summary };
    });
  }

  /**
   * What the task's runs did over the last `days` calendar days (today
   * included), with the days bucketed in `timezone`. Two queries, both scoped
   * by `user_id` and `task_id`. 404 `TASK_NOT_FOUND` unless the task is the user's.
   */
  async stats(userId: string, taskId: string, days: number, timezone: string, now = new Date()): Promise<TaskStats> {
    const task = await this.db(userId).task.findFirst({ where: { id: taskId }, select: { id: true } });
    if (!task) throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'Task not found' });
    const today = zonedDateKey(now, timezone);
    const first = addDaysToDateKey(today, -(days - 1));
    const from = zonedDayStart(first, timezone);
    const scope = Prisma.sql`r.user_id = ${userId}::uuid AND r.task_id = ${taskId}::uuid AND r.created_at >= ${from}`;
    const finished = Prisma.sql`r.status IN ('succeeded', 'failed', 'cancelled')`;
    const timed = Prisma.sql`${finished} AND r.started_at IS NOT NULL AND r.finished_at IS NOT NULL`;
    const seconds = Prisma.sql`EXTRACT(EPOCH FROM (r.finished_at - r.started_at))`;

    const [daily, groups] = await Promise.all([
      this.prisma.$queryRaw<{ day: string; succeeded: number; failed: number; cancelled: number; cost: unknown }[]>(Prisma.sql`
        SELECT to_char(r.created_at AT TIME ZONE ${timezone}::text, 'YYYY-MM-DD') AS day,
               (count(*) FILTER (WHERE r.status = 'succeeded'))::int AS succeeded,
               (count(*) FILTER (WHERE r.status = 'failed'))::int AS failed,
               (count(*) FILTER (WHERE r.status = 'cancelled'))::int AS cancelled,
               (sum(r.cost_usd) FILTER (WHERE r.cost_usd > 0))::float8 AS cost
        FROM runs r WHERE ${scope}
        GROUP BY 1`),
      // The row with `total = 1` is the whole period; the others are one stop reason each.
      this.prisma.$queryRaw<
        {
          total: number;
          reason: string | null;
          runs: number;
          succeeded: number;
          failed: number;
          cancelled: number;
          finished: number;
          avgDuration: unknown;
          p95Duration: unknown;
          avgSteps: unknown;
          cost: unknown;
          unpriced: number;
          avgCostSuccess: unknown;
        }[]
      >(Prisma.sql`
        SELECT GROUPING(r.stop_reason)::int AS total,
               r.stop_reason::text AS reason,
               count(*)::int AS runs,
               (count(*) FILTER (WHERE r.status = 'succeeded'))::int AS succeeded,
               (count(*) FILTER (WHERE r.status = 'failed'))::int AS failed,
               (count(*) FILTER (WHERE r.status = 'cancelled'))::int AS cancelled,
               (count(*) FILTER (WHERE ${finished}))::int AS finished,
               (avg(${seconds}) FILTER (WHERE ${timed}))::float8 AS "avgDuration",
               (percentile_cont(0.95) WITHIN GROUP (ORDER BY ${seconds}) FILTER (WHERE ${timed}))::float8 AS "p95Duration",
               (avg(r.step_count) FILTER (WHERE ${finished}))::float8 AS "avgSteps",
               (sum(r.cost_usd) FILTER (WHERE r.cost_usd > 0))::float8 AS cost,
               (count(*) FILTER (WHERE NOT r.cost_known))::int AS unpriced,
               (avg(r.cost_usd) FILTER (WHERE r.status = 'succeeded' AND r.cost_usd > 0))::float8 AS "avgCostSuccess"
        FROM runs r WHERE ${scope}
        GROUP BY GROUPING SETS ((), (r.stop_reason))`),
    ]);

    const all = groups.find((g) => g.total === 1);
    const byDay = new Map(daily.map((d) => [d.day, d]));
    const series: TaskStats['series'] = [];
    for (let i = 0; i < days; i++) {
      const date = addDaysToDateKey(first, i);
      const d = byDay.get(date);
      series.push({ date, succeeded: d?.succeeded ?? 0, failed: d?.failed ?? 0, cancelled: d?.cancelled ?? 0, costUsd: round(numOrNull(d?.cost), 6) });
    }
    const succeeded = all?.succeeded ?? 0;
    const failed = all?.failed ?? 0;
    return {
      days,
      timezone,
      totals: {
        runs: all?.runs ?? 0,
        succeeded,
        failed,
        cancelled: all?.cancelled ?? 0,
        successRate: succeeded + failed > 0 ? round(succeeded / (succeeded + failed), 4) : null,
        costUsd: round(numOrNull(all?.cost), 6),
        costKnown: (all?.unpriced ?? 0) === 0,
      },
      avgDurationSeconds: round(numOrNull(all?.avgDuration), 1),
      p95DurationSeconds: round(numOrNull(all?.p95Duration), 1),
      avgSteps: round(numOrNull(all?.avgSteps), 1),
      avgCostPerSuccessUsd: round(numOrNull(all?.avgCostSuccess), 6),
      series,
      stopReasons: groups
        .filter((g) => g.total === 0 && g.finished > 0)
        .map((g) => ({ reason: g.reason ?? 'unknown', count: g.finished }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    };
  }
}
