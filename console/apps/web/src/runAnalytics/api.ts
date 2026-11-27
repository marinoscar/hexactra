// Runs Analytics (E53.5, #1073): the client of `GET /runs/stats` (your runs) and `GET /admin/runs/stats` (everyone's, aggregates
// only), and the run dataset export (`POST /exports`, source `run-dataset`). The page draws what these answer.
import type { PlatformApiClient } from '@marinoscar/platform-web/core';

export type RunStatsScope = 'me' | 'all';
export const ANALYTICS_RANGES = ['7d', '30d', '90d', '1y'] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];
export const ANALYTICS_RANGE_LABEL: Record<AnalyticsRange, string> = { '7d': '7 days', '30d': '30 days', '90d': '90 days', '1y': '1 year' };
const RANGE_DAYS: Record<AnalyticsRange, number> = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };

export type Breakdown = 'task' | 'policy' | 'stopReason' | 'tier' | 'trigger' | 'user';
export const BREAKDOWN_LABEL: Record<Breakdown, string> = { task: 'Task', policy: 'Policy', stopReason: 'Stop reason', tier: 'Model tier', trigger: 'Trigger', user: 'User' };
/** The breakdowns offered: only the admin page groups by user. */
export const BREAKDOWNS: Record<RunStatsScope, Breakdown[]> = { me: ['task', 'policy', 'stopReason', 'tier', 'trigger'], all: ['user', 'task', 'policy', 'stopReason', 'tier', 'trigger'] };

export interface Distribution {
  n: number;
  sum: number;
  mean: number;
  min: number;
  p50: number;
  p90: number;
  max: number;
}
export type StatsMetric = 'workingMs' | 'wallMs' | 'steps' | 'modelCalls' | 'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'totalTokens' | 'costUsd';

export interface StatsGroup {
  runs: number;
  finished: number;
  live: number;
  byStatus: Record<'queued' | 'running' | 'waiting_human' | 'paused' | 'succeeded' | 'failed' | 'cancelled', number>;
  successRate: number | null;
  costPerSuccessUsd: number | null;
  costKnown: boolean;
  metrics: Record<StatsMetric, Distribution | null>;
}
export interface StatsGroupRow extends StatsGroup {
  key: string;
  label: string;
}
export interface RunStats {
  groupBy: string;
  timeZone: string;
  scanned: number;
  truncated: boolean;
  total: StatsGroup;
  groups: StatsGroupRow[];
  groupsTruncated: boolean;
}

/** The first moment of the range: `days` back from now (the API counts runs created at or after it). */
export function rangeFrom(range: AnalyticsRange, now = Date.now()): string {
  return new Date(now - RANGE_DAYS[range] * 86_400_000).toISOString();
}

/** Days for the shorter ranges, weeks for a year (52 bars, not 365). */
export function periodOf(range: AnalyticsRange): 'day' | 'week' {
  return range === '1y' ? 'week' : 'day';
}

export function getRunStats(api: PlatformApiClient, q: { scope: RunStatsScope; range: AnalyticsRange; groupBy: Breakdown | 'day' | 'week' }, signal?: AbortSignal, now = Date.now()): Promise<RunStats> {
  const params = new URLSearchParams({ groupBy: q.groupBy, from: rangeFrom(q.range, now) });
  return api.get<RunStats>(`${q.scope === 'all' ? '/admin/runs/stats' : '/runs/stats'}?${params}`, { signal });
}

/** Starts the run dataset of the range (your runs, with steps) as a JSON export; the Your data page shows it and its download. */
export function startRunDataset(api: PlatformApiClient, range: AnalyticsRange, now = Date.now()): Promise<{ id: string; status: string }> {
  return api.post<{ id: string; status: string }>('/exports', { source: 'run-dataset', format: 'json', request: { from: rangeFrom(range, now).slice(0, 10), status: 'all', includeSteps: true } });
}

/** Where a breakdown row's runs are listed (your own page only), or null when the list has no such filter. */
export function runsLink(groupBy: Breakdown, key: string, range: AnalyticsRange, now = Date.now()): string | null {
  const p = new URLSearchParams({ from: rangeFrom(range, now).slice(0, 10) });
  if (groupBy === 'task') p.set('taskId', key);
  else if (groupBy === 'policy' && key !== 'none') p.set('policyId', key);
  else if (groupBy === 'stopReason' && key !== 'none') p.set('stopReason', key);
  else if (groupBy === 'trigger') p.set('trigger', key);
  else return null;
  return `/runs?${p}`;
}

/** `45s`, `3.2 min`, `1.5 h`. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '–';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toLocaleString('en-US', { maximumFractionDigits: 1 })} min`;
  return `${(ms / 3_600_000).toLocaleString('en-US', { maximumFractionDigits: 1 })} h`;
}

/** `950`, `34.5k`, `1.2M`. */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return '–';
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 1 })}M`;
  if (n >= 10_000) return `${(n / 1_000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k`;
  return Math.round(n).toLocaleString('en-US');
}

/** What a stop reason or tier key is called on screen. */
export function keyLabel(groupBy: Breakdown, row: { key: string; label: string }): string {
  if (groupBy === 'stopReason') return STOP_REASON_LABEL[row.key] ?? row.label;
  if (groupBy === 'tier' && row.key === 'none') return 'Not started';
  return row.label;
}

const STOP_REASON_LABEL: Record<string, string> = {
  finished: 'Finished',
  stalled: 'Stalled',
  cancelled: 'Stopped by you',
  error: 'Error',
  no_model: 'No model',
  budget_actions: 'Budget: actions',
  budget_model_calls: 'Budget: model calls',
  budget_active_time: 'Budget: working time',
  budget_input_tokens: 'Budget: input tokens',
  budget_output_tokens: 'Budget: output tokens',
  budget_cost: 'Budget: cost',
  none: 'Still running',
};
