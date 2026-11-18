// Reading runs a page at a time (#420): the WHERE builder every run filter
// shares, the keyset cursor, the paged list and the counts per status.
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { builtinPolicy } from '../policies/builtin-policies';
import { POLICY_SOURCES, type PolicySource, type RunPolicySummary } from '../policies/policy-snapshot';
import { PrismaService } from '../prisma/prisma.service';
import { readConfirmedActions } from '../runner/confirmed-actions';
import { readEffectiveBudget, runBudgetView, type RunBudgetView } from '../runner/budget';
import './runs.errors';
import { withCost } from './run-cost';
import type { RunStatus } from './run-status';
import { BUDGET_STOP_REASONS, LIVE_RUN_STATUSES, RUN_STATES, RUN_STATUSES, type RunFilter } from './runs.schemas';

function invalidFilter(message: string): BadRequestException {
  return new BadRequestException({ code: 'INVALID_FILTER', message });
}

/**
 * The Prisma WHERE of a run filter. It carries no user: run it through
 * `prisma.forUser({ userId })`, which confines it to that user's rows.
 * Throws 400 `INVALID_FILTER` for `status` with `state`, and for `from` after `to`.
 */
export function runWhere(filter: RunFilter): Prisma.RunWhereInput {
  if (filter.status && filter.state) throw invalidFilter('Use status or state, not both');
  const from = filter.from ? new Date(filter.from) : undefined;
  const to = filter.to ? new Date(filter.to) : undefined;
  if (from && to && from.getTime() > to.getTime()) throw invalidFilter('from must not be after to');
  const statuses = filter.status ?? (filter.state ? [...RUN_STATES[filter.state]] : undefined);
  const stopReasons = filter.stopReason ? [...new Set(filter.stopReason.flatMap((r) => (r === 'budget' ? BUDGET_STOP_REASONS : [r])))] : undefined;
  return {
    ...(statuses ? { status: { in: statuses } } : {}),
    ...(filter.taskId ? { taskId: filter.taskId === 'none' ? null : filter.taskId } : {}),
    ...(filter.trigger ? { trigger: { in: filter.trigger } } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
    ...(filter.q ? { goal: { contains: filter.q, mode: 'insensitive' as const } } : {}),
    ...(stopReasons ? { stopReason: { in: stopReasons } } : {}),
    ...(filter.policyId ? { policyRef: filter.policyId } : {}),
    ...(filter.origin ? { origin: { in: filter.origin } } : {}),
    ...(filter.clientId ? { clientId: filter.clientId } : {}),
  };
}

/** Where a page ended: the last row's creation time (to the microsecond, as stored) and id. */
export interface RunCursor {
  c: string;
  i: string;
}

const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The opaque `nextCursor`: base64url of `{ c, i }`. Clients pass it back unchanged. */
export function encodeRunCursor(cursor: RunCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Throws 400 `INVALID_CURSOR` for anything `encodeRunCursor` did not produce. */
export function decodeRunCursor(text: string): RunCursor {
  try {
    const v = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Partial<RunCursor> | null;
    if (v && typeof v.c === 'string' && typeof v.i === 'string' && CURSOR_TIME.test(v.c) && UUID.test(v.i) && !Number.isNaN(Date.parse(v.c))) return { c: v.c, i: v.i };
  } catch {
    // Not base64url JSON: the same answer as a well-formed cursor of the wrong shape.
  }
  throw new BadRequestException({ code: 'INVALID_CURSOR', message: 'The cursor is not valid; start again from the first page' });
}

export interface ListRunsQuery extends RunFilter {
  cursor?: string;
  limit: number;
  order: 'desc' | 'asc';
}

/** What a list row keeps of `runs.policy_snapshot`, read in SQL so the snapshot never leaves the database. */
interface RunRowExtras {
  id: string;
  c: string;
  ref: string | null;
  name: string | null;
  version: number | null;
  source: string | null;
  builtin: boolean | null;
  effective_budget: unknown;
}

/** The six statuses, each with its count. */
export type RunStatusCounts = Record<RunStatus, number>;

export interface RunCounts {
  total: number;
  /** queued + running + waiting_human. */
  live: number;
  byStatus: RunStatusCounts;
  /** USD over the counted runs; null when none of them made a model call. A lower bound while `costKnown` is false. */
  costUsd: number | null;
  /** False when a counted run had a call that could not be priced. */
  costKnown: boolean;
}

/**
 * The runs list and its counts, always through `forUser()`. List rows never
 * carry `transcript` or `policySnapshot`: the policy summary (and a live run's
 * budget) come from the snapshot's few fields, selected in SQL.
 */
@Injectable()
export class RunsQueryService {
  private readonly log = new Logger(RunsQueryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * One page of the user's runs by keyset on `(createdAt, id)`: no OFFSET.
   * `nextCursor` is null on the last page (and on an empty one).
   */
  async list(userId: string, q: ListRunsQuery) {
    const started = Date.now();
    const filter = runWhere(q);
    const after = q.cursor ? await this.afterCursor(userId, decodeRunCursor(q.cursor), q.order) : undefined;
    const rows = await this.prisma.forUser({ userId }).run.findMany({
      where: after ? { AND: [filter, after] } : filter,
      orderBy: [{ createdAt: q.order }, { id: q.order }],
      take: q.limit + 1,
      omit: { transcript: true, policySnapshot: true },
      include: { task: { select: { name: true } } },
    });
    const page = rows.slice(0, q.limit);
    const extras = await this.extras(userId, page.map((r) => r.id));
    const now = Date.now();
    const items = page.map((row) => {
      const { task, policyRef: _ref, policyVersion: _version, policySource: _source, ...run } = withCost(row);
      const x = extras.get(row.id);
      return { ...run, confirmedActions: readConfirmedActions(row.confirmedActions).length, taskName: task?.name ?? null, policy: policySummary(x), budget: budgetView(x, row, now) };
    });
    const last = page.at(-1);
    const lastTime = last ? extras.get(last.id)?.c : undefined;
    const nextCursor = rows.length > q.limit && last && lastTime ? encodeRunCursor({ c: lastTime, i: last.id }) : null;
    // Which filters were used, never their values: a goal search is the user's text.
    this.log.debug(`runs list user=${userId} filters=[${usedFilters(q).join(',')}] order=${q.order} rows=${items.length} ms=${Date.now() - started}`);
    return { items, nextCursor };
  }

  /** How many runs match, per status, with their cost: one GROUP BY. */
  async counts(userId: string, filter: Omit<RunFilter, 'status' | 'state'>): Promise<RunCounts> {
    const started = Date.now();
    const groups = await this.prisma.forUser({ userId }).run.groupBy({
      by: ['status', 'costKnown'],
      where: runWhere(filter),
      _count: { _all: true },
      _sum: { costUsd: true, modelCalls: true },
    });
    const byStatus = Object.fromEntries(RUN_STATUSES.map((s) => [s, 0])) as RunStatusCounts;
    let cost = new Prisma.Decimal(0);
    let modelCalls = 0;
    let costKnown = true;
    for (const g of groups) {
      byStatus[g.status] += g._count._all;
      cost = cost.plus(g._sum.costUsd ?? 0);
      modelCalls += g._sum.modelCalls ?? 0;
      if (!g.costKnown) costKnown = false;
    }
    const total = RUN_STATUSES.reduce((n, s) => n + byStatus[s], 0);
    this.log.debug(`runs counts user=${userId} filters=[${usedFilters(filter).join(',')}] total=${total} ms=${Date.now() - started}`);
    return { total, live: LIVE_RUN_STATUSES.reduce((n, s) => n + byStatus[s], 0), byStatus, costUsd: modelCalls > 0 ? Number(cost) : null, costKnown };
  }

  /**
   * The rows after a cursor. `created_at` is stored to the microsecond and a
   * JavaScript date holds milliseconds, so the cursor's own millisecond is
   * settled in SQL (which rows of it come after the cursor) and everything
   * beyond it is a plain comparison.
   */
  private async afterCursor(userId: string, cursor: RunCursor, order: 'desc' | 'asc'): Promise<Prisma.RunWhereInput> {
    const ms = new Date(`${cursor.c.slice(0, 23)}Z`);
    const next = new Date(ms.getTime() + 1);
    const beyond = order === 'desc' ? Prisma.sql`<` : Prisma.sql`>`;
    const same = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM runs
      WHERE user_id = ${userId}::uuid AND created_at >= ${ms} AND created_at < ${next}
        AND (created_at, id) ${beyond} (${cursor.c}::timestamptz, ${cursor.i}::uuid)`;
    const rest: Prisma.RunWhereInput = order === 'desc' ? { createdAt: { lt: ms } } : { createdAt: { gte: next } };
    return same.length > 0 ? { OR: [rest, { id: { in: same.map((r) => r.id) } }] } : rest;
  }

  private async extras(userId: string, ids: string[]): Promise<Map<string, RunRowExtras>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<RunRowExtras[]>`
      SELECT id::text AS id,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS c,
             policy_snapshot->>'ref' AS ref,
             policy_snapshot->>'name' AS name,
             CASE WHEN jsonb_typeof(policy_snapshot->'version') = 'number' THEN (policy_snapshot->>'version')::int END AS version,
             policy_snapshot->>'source' AS source,
             CASE WHEN jsonb_typeof(policy_snapshot->'builtin') = 'boolean' THEN (policy_snapshot->>'builtin')::boolean END AS builtin,
             CASE WHEN status IN ('queued', 'running', 'waiting_human') THEN policy_snapshot->'effectiveBudget' END AS effective_budget
      FROM runs
      WHERE user_id = ${userId}::uuid AND id = ANY(${ids}::uuid[])`;
    return new Map(rows.map((r) => [r.id, r]));
  }
}

/** The filter parameters a query used (names only). */
function usedFilters(q: object): string[] {
  return Object.entries(q)
    .filter(([k, v]) => v !== undefined && !['limit', 'order', 'envelope'].includes(k))
    .map(([k]) => k);
}

/** `policy { id, name, version, source, builtin }`; null until the run's first advance has snapshotted it. */
function policySummary(x: RunRowExtras | undefined): RunPolicySummary | null {
  if (!x || x.ref === null || x.name === null || x.version === null) return null;
  const source = (POLICY_SOURCES as readonly string[]).includes(x.source ?? '') ? (x.source as PolicySource) : 'system_default';
  return { id: x.ref, name: x.name, version: x.version, source, builtin: x.builtin ?? builtinPolicy(x.ref) !== undefined };
}

/** A live run's budget; a finished run's is on `GET /runs/:id`. */
function budgetView(x: RunRowExtras | undefined, run: Parameters<typeof runBudgetView>[1], nowMs: number): RunBudgetView | null {
  const effective = x ? readEffectiveBudget(x.effective_budget) : undefined;
  return effective ? runBudgetView(effective, run, nowMs) : null;
}
