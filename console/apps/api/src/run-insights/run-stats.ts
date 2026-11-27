// Run statistics (E53.1, #1069): how a set of runs behaved as a population. Counts per status, the success rate, and the
// distribution (n, sum, mean, min, p50, p90, max) of working time, wall time, steps, model calls, tokens and cost, overall and per group.
// The database aggregates (run-stats.service.ts, over the runs list's own filter); this file turns its rows into the answer: rounding,
// rates, labels, order and the group cap. Pure, so every rule is unit-tested.
//
// The percentiles use the method of `spreadOf` (task-consistency.ts, the Consistency card), so the two never disagree: the median is the
// mean of the two middle values of an even list (`percentile_cont(0.5)`), the 90th percentile is by the nearest rank (`percentile_disc(0.9)`).

import { RUN_STATUSES } from '../tasks/runs.schemas';
import type { RunStatus } from '../tasks/run-status';

/** What a statistic can be grouped by. `none` answers the total only. */
export const RUN_STATS_GROUP_BY = ['none', 'task', 'policy', 'stopReason', 'status', 'trigger', 'origin', 'tier', 'day', 'week'] as const;
/** The admin route (E53.2) also groups by user. */
export const RUN_STATS_ADMIN_GROUP_BY = [...RUN_STATS_GROUP_BY, 'user'] as const;
export type RunStatsGroupBy = (typeof RUN_STATS_ADMIN_GROUP_BY)[number];

/** The most runs one answer reads (the newest); beyond it `truncated` is true. */
export const RUN_STATS_MAX_RUNS = 100_000;
/** The most groups one answer carries; beyond it `groupsTruncated` is true (the largest groups, or the latest periods, are kept). */
export const RUN_STATS_MAX_GROUPS = 400;

export const RUN_STATS_METRICS = ['workingMs', 'wallMs', 'steps', 'modelCalls', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens', 'costUsd'] as const;
export type RunStatsMetric = (typeof RUN_STATS_METRICS)[number];

/** The distribution of one measure over the finished runs of a group; null when the group has no finished run with a value. */
export interface Distribution {
  n: number;
  sum: number;
  mean: number;
  min: number;
  p50: number;
  p90: number;
  max: number;
}

/** One measure as the database aggregates it: null fields when no finished run had a value. */
export interface RawDistribution {
  n: number;
  sum: number | null;
  min: number | null;
  p50: number | null;
  p90: number | null;
  max: number | null;
}

/** One group as the database aggregates it. */
export interface RawRunStatsGroup {
  /** The group key; '' for the total. */
  key: string;
  byStatus: Record<RunStatus, number>;
  /** False when a finished run of the group had a model call that could not be priced. */
  costKnown: boolean;
  metrics: Record<RunStatsMetric, RawDistribution>;
}

export interface RunStatsGroup {
  /** Every matched run, live or finished. */
  runs: number;
  /** succeeded + failed + cancelled: the runs the distributions and the success rate are over. */
  finished: number;
  /** queued + running + waiting_human + paused. */
  live: number;
  byStatus: Record<RunStatus, number>;
  /** succeeded ÷ finished, 0..1 to three decimals; null with no finished run. */
  successRate: number | null;
  /** The finished runs' cost ÷ the succeeded runs; null with none succeeded. A lower bound while `costKnown` is false. */
  costPerSuccessUsd: number | null;
  costKnown: boolean;
  metrics: Record<RunStatsMetric, Distribution | null>;
}

export interface RunStatsGroupRow extends RunStatsGroup {
  /** An id, a value, `none`, or the first day of the period (`YYYY-MM-DD`). */
  key: string;
  /** What a person reads; for a period the date itself. */
  label: string;
}

export interface RunStats {
  groupBy: RunStatsGroupBy;
  /** The IANA time zone the days and weeks are in. */
  timeZone: string;
  /** Runs read: at most `RUN_STATS_MAX_RUNS`. */
  scanned: number;
  /** True when more runs matched than were read: the statistics are over the newest `scanned`. */
  truncated: boolean;
  total: RunStatsGroup;
  /** Empty for `groupBy=none`. Periods oldest first; every other grouping largest first. A period with no run is absent. */
  groups: RunStatsGroupRow[];
  groupsTruncated: boolean;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
/** USD to the micro-dollar, as `runs.cost_usd` stores it. */
const roundUsd = (n: number) => Math.round(n * 1e6) / 1e6;

/** A measure, rounded only at the end: to three decimals, or to the micro-dollar for cost. */
export function distributionOf(raw: RawDistribution, usd = false): Distribution | null {
  if (raw.n === 0 || raw.sum === null || raw.min === null || raw.p50 === null || raw.p90 === null || raw.max === null) return null;
  const r = usd ? roundUsd : round3;
  return { n: raw.n, sum: r(raw.sum), mean: r(raw.sum / raw.n), min: r(raw.min), p50: r(raw.p50), p90: r(raw.p90), max: r(raw.max) };
}

/** An empty group (no run matched). */
export function emptyRawGroup(key = ''): RawRunStatsGroup {
  const none: RawDistribution = { n: 0, sum: null, min: null, p50: null, p90: null, max: null };
  return { key, byStatus: Object.fromEntries(RUN_STATUSES.map((s) => [s, 0])) as Record<RunStatus, number>, costKnown: true, metrics: Object.fromEntries(RUN_STATS_METRICS.map((m) => [m, none])) as Record<RunStatsMetric, RawDistribution> };
}

/** A group's answer from its aggregates. */
export function groupStats(raw: RawRunStatsGroup): RunStatsGroup {
  const b = raw.byStatus;
  const finished = b.succeeded + b.failed + b.cancelled;
  const live = b.queued + b.running + b.waiting_human + b.paused;
  const metrics = Object.fromEntries(RUN_STATS_METRICS.map((m) => [m, distributionOf(raw.metrics[m], m === 'costUsd')])) as Record<RunStatsMetric, Distribution | null>;
  const cost = raw.metrics.costUsd.sum ?? 0;
  return {
    runs: finished + live,
    finished,
    live,
    byStatus: { ...b },
    successRate: finished ? round3(b.succeeded / finished) : null,
    costPerSuccessUsd: b.succeeded ? roundUsd(cost / b.succeeded) : null,
    costKnown: raw.costKnown,
    metrics,
  };
}

export interface RunStatsInput {
  total: RawRunStatsGroup;
  groups: readonly RawRunStatsGroup[];
  groupBy: RunStatsGroupBy;
  timeZone: string;
  scanned: number;
  truncated: boolean;
  /** A group's label from its key (task and policy names); the key itself when it answers undefined. */
  label?: (key: string) => string | undefined;
}

/** The answer: the total, and the groups labelled, ordered and capped. */
export function runStatsOf(input: RunStatsInput): RunStats {
  const { groupBy } = input;
  const base = { groupBy, timeZone: input.timeZone, scanned: input.scanned, truncated: input.truncated, total: groupStats(input.total) };
  if (groupBy === 'none') return { ...base, groups: [], groupsTruncated: false };
  const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  let groups = input.groups.map((g) => ({ key: g.key, label: input.label?.(g.key) ?? g.key, ...groupStats(g) }));
  const groupsTruncated = groups.length > RUN_STATS_MAX_GROUPS;
  if (groupBy === 'day' || groupBy === 'week') {
    groups.sort(byKey);
    if (groupsTruncated) groups = groups.slice(-RUN_STATS_MAX_GROUPS);
  } else {
    groups.sort((a, b) => b.runs - a.runs || byKey(a, b));
    if (groupsTruncated) groups = groups.slice(0, RUN_STATS_MAX_GROUPS);
  }
  return { ...base, groups, groupsTruncated };
}
