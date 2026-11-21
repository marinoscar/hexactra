// AI usage rollups (#732, epic #730): `ai_usage_events` summed per UTC hour
// into `ai_usage_hourly`, and the reader every usage report goes through.
//
// The rollup REPLACES a window of whole hours in one transaction (delete, then
// insert the ledger's sums), so running it twice gives the same rows and a
// ledger row written late (a call that ended after its hour was rolled) is
// picked up by the next run, which re-rolls the last `ROLLUP_REWIND_HOURS`.
// `ai_usage_rollup_state.rolled_until` says how far the rollups go: a report
// reads the rollups before it and the ledger from it on, so it is never behind
// and never counts an hour twice.
import { Injectable, Logger } from '@nestjs/common';
import { registerSystemAccessReason } from '@marinoscar/platform-api/core';
import { Prisma } from '@prisma/client';

import { PrismaSystemService } from '../prisma/prisma-system.service';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Hours re-rolled on every run, for ledger rows written after their hour was rolled. */
export const ROLLUP_REWIND_HOURS = 2;
/** The most hours one transaction rolls (a backfill goes in chunks of this). */
export const ROLLUP_CHUNK_HOURS = 7 * 24;
/** Rollup hours older than this many days are deleted (25 months). */
export const ROLLUP_KEEP_DAYS = 761;

export const USAGE_ROLLUP_REASON = 'usage-rollup';
registerSystemAccessReason({ id: USAGE_ROLLUP_REASON, description: 'The AI usage rollup job and the usage reports: sums of `ai_usage_events` across organizations into `ai_usage_hourly`, and reads of them.' });

/** The start of the UTC hour of `d`. */
export function floorHour(d: Date): Date {
  return new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS);
}

/** The windows to roll: from the watermark (rewound) or the first ledger row, to the current hour, in chunks. Pure. */
export function rollupWindows(rolledUntil: Date | null, firstEvent: Date | null, now: Date): { from: Date; to: Date }[] {
  const to = floorHour(now);
  const start = rolledUntil ? new Date(rolledUntil.getTime() - ROLLUP_REWIND_HOURS * HOUR_MS) : firstEvent ? floorHour(firstEvent) : null;
  if (!start || start >= to) return [];
  const out: { from: Date; to: Date }[] = [];
  for (let from = start; from < to; ) {
    const end = new Date(Math.min(from.getTime() + ROLLUP_CHUNK_HOURS * HOUR_MS, to.getTime()));
    out.push({ from, to: end });
    from = end;
  }
  return out;
}

/** One pass of the rollup. */
export interface RollupPass {
  windows: number;
  hours: number;
  rows: number;
  purged: number;
  rolledUntil: string | null;
}

/** The dimensions a usage row carries, shared by the rollups and the ledger. */
export const USAGE_DIMENSIONS = ['org_id', 'user_id', 'provider', 'model_id', 'operation', 'feature', 'key_source'] as const;

/** Filters of a usage read. Every value is bound, never spliced. */
export interface UsageFilter {
  from: Date;
  to: Date;
  userId?: string;
  orgId?: string;
  provider?: string;
  model?: string;
  feature?: string;
  /** Leave catalogue syncs out (they have no tokens and nobody pays per token for them). Default true. */
  excludeCatalog?: boolean;
}

/** One summed row of a usage read: an hour × dimensions slice. */
export interface UsageRow {
  hour: Date;
  orgId: string | null;
  userId: string | null;
  provider: string;
  modelId: string;
  operation: string;
  feature: string | null;
  keySource: string;
  requests: number;
  failed: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  latencyMsSum: number;
}

@Injectable()
export class UsageRollupService {
  private readonly log = new Logger(UsageRollupService.name);

  constructor(private readonly system: PrismaSystemService) {}

  /** Rolls every due window and deletes hours past the keep limit. `now` is for tests. */
  async roll(now = new Date()): Promise<RollupPass> {
    const db = this.system.asSystem(USAGE_ROLLUP_REASON);
    const state = await db.aiUsageRollupState.findUnique({ where: { id: 1 } });
    const first = state?.rolledUntil ? null : ((await db.aiUsageEvent.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }))?.createdAt ?? null);
    const windows = rollupWindows(state?.rolledUntil ?? null, first, now);
    const pass: RollupPass = { windows: windows.length, hours: 0, rows: 0, purged: 0, rolledUntil: state?.rolledUntil?.toISOString() ?? null };
    for (const w of windows) {
      pass.rows += await this.rollWindow(w.from, w.to);
      pass.hours += (w.to.getTime() - w.from.getTime()) / HOUR_MS;
      pass.rolledUntil = w.to.toISOString();
    }
    if (windows.length === 0 && !state?.rolledUntil && !first) {
      // Nothing in the ledger yet: the rollups are complete up to now.
      await this.setWatermark(floorHour(now));
      pass.rolledUntil = floorHour(now).toISOString();
    }
    const cutoff = new Date(floorHour(now).getTime() - ROLLUP_KEEP_DAYS * DAY_MS);
    pass.purged = (await db.aiUsageHourly.deleteMany({ where: { hour: { lt: cutoff } } })).count;
    return pass;
  }

  /** Replaces the hours in [from, to) with the ledger's sums, and moves the watermark to `to`, in one transaction. */
  async rollWindow(from: Date, to: Date): Promise<number> {
    return this.system.runAsSystem(USAGE_ROLLUP_REASON, async (tx) => {
      await tx.$executeRaw(Prisma.sql`DELETE FROM ai_usage_hourly WHERE hour >= ${from} AND hour < ${to}`);
      const rows = await tx.$executeRaw(Prisma.sql`
        WITH base AS (
          SELECT date_trunc('hour', created_at, 'UTC') AS hour, org_id, user_id, provider, model_id, operation, feature, key_source,
                 status, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, latency_ms, units
          FROM ai_usage_events
          WHERE created_at >= ${from} AND created_at < ${to}
        ),
        unit_sums AS (
          SELECT hour, org_id, user_id, provider, model_id, operation, feature, key_source, jsonb_object_agg(unit, amount) AS units
          FROM (
            SELECT b.hour, b.org_id, b.user_id, b.provider, b.model_id, b.operation, b.feature, b.key_source, u.key AS unit, sum((u.value)::numeric) AS amount
            FROM base b, LATERAL jsonb_each(CASE WHEN jsonb_typeof(b.units) = 'object' THEN b.units ELSE '{}'::jsonb END) AS u
            WHERE jsonb_typeof(u.value) = 'number'
            GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
          ) per_unit
          GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
        ),
        sums AS (
          SELECT hour, org_id, user_id, provider, model_id, operation, feature, key_source,
                 count(*)::int AS requests,
                 count(*) FILTER (WHERE status = 'failed')::int AS failed,
                 coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
                 coalesce(sum(cached_input_tokens), 0)::bigint AS cached_input_tokens,
                 coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
                 coalesce(sum(reasoning_tokens), 0)::bigint AS reasoning_tokens,
                 count(*) FILTER (WHERE input_tokens IS NULL AND output_tokens IS NULL)::int AS untokened_requests,
                 coalesce(sum(latency_ms), 0)::bigint AS latency_ms_sum
          FROM base
          GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
        )
        INSERT INTO ai_usage_hourly (id, hour, org_id, user_id, provider, model_id, operation, feature, key_source,
          requests, failed, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, untokened_requests, latency_ms_sum, units)
        SELECT gen_random_uuid(), s.hour, s.org_id, s.user_id, s.provider, s.model_id, s.operation, s.feature, s.key_source,
          s.requests, s.failed, s.input_tokens, s.cached_input_tokens, s.output_tokens, s.reasoning_tokens, s.untokened_requests, s.latency_ms_sum, u.units
        FROM sums s
        LEFT JOIN unit_sums u
          ON u.hour = s.hour AND u.org_id IS NOT DISTINCT FROM s.org_id AND u.user_id IS NOT DISTINCT FROM s.user_id
         AND u.provider = s.provider AND u.model_id = s.model_id AND u.operation = s.operation
         AND u.feature IS NOT DISTINCT FROM s.feature AND u.key_source = s.key_source
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO ai_usage_rollup_state (id, rolled_until, updated_at) VALUES (1, ${to}, now())
        ON CONFLICT (id) DO UPDATE SET rolled_until = GREATEST(ai_usage_rollup_state.rolled_until, EXCLUDED.rolled_until), updated_at = now()
      `);
      return rows;
    });
  }

  /** How far the rollups go; null before the first run. */
  async watermark(): Promise<Date | null> {
    const db = this.system.asSystem(USAGE_ROLLUP_REASON);
    return (await db.aiUsageRollupState.findUnique({ where: { id: 1 } }))?.rolledUntil ?? null;
  }

  /**
   * The usage in [from, to) summed per UTC hour and dimension: the rollups
   * before the watermark, the ledger from it on (and everything from the
   * ledger before the first rollup). Each row is one hour × one slice.
   */
  async rows(f: UsageFilter): Promise<UsageRow[]> {
    const mark = await this.watermark();
    const split = mark ? new Date(Math.min(Math.max(mark.getTime(), f.from.getTime()), f.to.getTime())) : f.from;
    const where = (col: (c: string) => Prisma.Sql) => {
      const parts: Prisma.Sql[] = [];
      if (f.userId) parts.push(Prisma.sql`${col('user_id')} = ${f.userId}::uuid`);
      if (f.orgId) parts.push(Prisma.sql`${col('org_id')} = ${f.orgId}::uuid`);
      if (f.provider) parts.push(Prisma.sql`${col('provider')} = ${f.provider}`);
      if (f.model) parts.push(Prisma.sql`${col('model_id')} = ${f.model}`);
      if (f.feature) parts.push(Prisma.sql`${col('feature')} = ${f.feature}`);
      if (f.excludeCatalog !== false) parts.push(Prisma.sql`${col('operation')} <> 'catalog'`);
      return parts.length ? Prisma.sql` AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty;
    };
    const c = (name: string) => Prisma.raw(`"${name}"`);
    const rows = await this.system.asSystem(USAGE_ROLLUP_REASON).$queryRaw<Record<string, unknown>[]>(Prisma.sql`
      SELECT hour, org_id, user_id, provider, model_id, operation, feature, key_source,
             sum(requests)::float8 AS requests, sum(failed)::float8 AS failed,
             sum(input_tokens)::float8 AS input_tokens, sum(cached_input_tokens)::float8 AS cached_input_tokens,
             sum(output_tokens)::float8 AS output_tokens, sum(reasoning_tokens)::float8 AS reasoning_tokens,
             sum(latency_ms_sum)::float8 AS latency_ms_sum
      FROM (
        SELECT hour, org_id, user_id, provider, model_id, operation, feature, key_source,
               requests, failed, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, latency_ms_sum
        FROM ai_usage_hourly
        WHERE hour >= ${f.from} AND hour < ${split}${where(c)}
        UNION ALL
        SELECT date_trunc('hour', created_at, 'UTC'), org_id, user_id, provider, model_id, operation, feature, key_source,
               1, (status = 'failed')::int, coalesce(input_tokens, 0), coalesce(cached_input_tokens, 0),
               coalesce(output_tokens, 0), coalesce(reasoning_tokens, 0), latency_ms
        FROM ai_usage_events
        WHERE created_at >= ${split} AND created_at < ${f.to}${where(c)}
      ) u
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
      ORDER BY 1
    `);
    return rows.map((r) => ({
      hour: r.hour as Date,
      orgId: (r.org_id as string | null) ?? null,
      userId: (r.user_id as string | null) ?? null,
      provider: String(r.provider),
      modelId: String(r.model_id),
      operation: String(r.operation),
      feature: (r.feature as string | null) ?? null,
      keySource: String(r.key_source),
      requests: Number(r.requests),
      failed: Number(r.failed),
      inputTokens: Number(r.input_tokens),
      cachedInputTokens: Number(r.cached_input_tokens),
      outputTokens: Number(r.output_tokens),
      reasoningTokens: Number(r.reasoning_tokens),
      latencyMsSum: Number(r.latency_ms_sum),
    }));
  }

  private async setWatermark(to: Date): Promise<void> {
    await this.system.runAsSystem(USAGE_ROLLUP_REASON, (tx) =>
      tx.$executeRaw(Prisma.sql`
        INSERT INTO ai_usage_rollup_state (id, rolled_until, updated_at) VALUES (1, ${to}, now())
        ON CONFLICT (id) DO UPDATE SET rolled_until = GREATEST(ai_usage_rollup_state.rolled_until, EXCLUDED.rolled_until), updated_at = now()
      `),
    );
  }
}
