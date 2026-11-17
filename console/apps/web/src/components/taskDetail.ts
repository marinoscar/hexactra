// The task page (#428) without React: its requests, and the words of its
// statistics, its subtitle and its configuration. Pure apart from the requests.
import type { PlatformApiClient } from '@marinoscar/platform-web/core';

import type { ScheduleItemInput } from '../schedule/draft';
import type { RunListItem, RunPage } from '../types/runs';
import type { TaskSchedule, TaskStats, TaskSummary, TaskWithSummary } from '../types/tasks';
import { formatCost, stopReasonLabel } from '../ui';

/** The whole page refreshes this often while it is visible. */
export const TASK_DETAIL_REFRESH_MS = 15_000;
/** While the task has a live run. */
export const TASK_DETAIL_LIVE_REFRESH_MS = 5_000;

/** The periods the statistics offer, in days. */
export const STATS_PERIODS = [7, 30, 90] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];
export const DEFAULT_STATS_PERIOD: StatsPeriod = 30;
/** The days the chart shows on a phone. */
export const CHART_DAYS_ON_PHONE = 14;

// ---- Requests ----

/** `GET /tasks/:id?include=summary`. */
export function getTaskDetail(api: PlatformApiClient, id: string, signal?: AbortSignal): Promise<TaskWithSummary> {
  return api.get<TaskWithSummary>(`/tasks/${encodeURIComponent(id)}?include=summary`, { signal });
}

/** `GET /tasks/:id/stats?days=`: outcomes, durations and cost of the task's runs, per day. Needs `runs:read`. */
export function getTaskStats(api: PlatformApiClient, id: string, days: StatsPeriod): Promise<TaskStats> {
  return api.get<TaskStats>(`/tasks/${id}/stats?days=${days}`);
}

/** The task's newest run (`live`: its newest live one) as the runs list serves it: status, stop reason, activity. Null when there is none. */
export async function getTaskRun(api: PlatformApiClient, taskId: string, live: boolean): Promise<RunListItem | null> {
  const page = await api.get<RunPage>(`/runs?envelope=1&taskId=${taskId}&limit=1${live ? '&state=live' : ''}`);
  return page.items[0] ?? null;
}

/** `GET /schedules?taskId=`: the task's schedules with what the summary leaves out (each one's last run). */
export function listTaskSchedules(api: PlatformApiClient, taskId: string): Promise<TaskSchedule[]> {
  return api.get<TaskSchedule[]>(`/schedules?taskId=${taskId}`);
}

/** `POST /schedules`: one more schedule for the task. */
export function createSchedule(api: PlatformApiClient, taskId: string, item: ScheduleItemInput): Promise<TaskSchedule> {
  const { id: _id, ...fields } = item;
  return api.post<TaskSchedule>('/schedules', { taskId, ...fields });
}

/** `PATCH /schedules/:id`: pause or resume it (`{ enabled }`), or save an edit (expression, zone, overlap rule, policy override). */
export function updateSchedule(api: PlatformApiClient, id: string, patch: Partial<Omit<ScheduleItemInput, 'id'>>): Promise<TaskSchedule> {
  return api.patch<TaskSchedule>(`/schedules/${id}`, patch);
}

/** `DELETE /schedules/:id`. */
export function deleteSchedule(api: PlatformApiClient, id: string): Promise<void> {
  return api.delete<void>(`/schedules/${id}`);
}

// ---- Words ----

/** A duration in words: "45 s", "3 min 20 s", "2 h 5 min". */
export function durationWords(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return s % 60 === 0 ? `${min} min` : `${min} min ${s % 60} s`;
  return min % 60 === 0 ? `${Math.floor(min / 60)} h` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** The success rate tile: "92 %" of the runs that succeeded or failed; "n/a" when none did. */
export function successRate(totals: TaskStats['totals']): { value: string; detail: string } {
  const finished = totals.succeeded + totals.failed;
  if (totals.successRate === null || finished === 0) return { value: 'n/a', detail: 'no finished run' };
  const cancelled = totals.cancelled > 0 ? ` · ${totals.cancelled.toLocaleString('en-US')} cancelled not counted` : '';
  return { value: `${Math.round(totals.successRate * 100)} %`, detail: `of ${count(finished, 'finished run', 'finished runs')}${cancelled}` };
}

/**
 * The spend tile: the period's total ("$4.20"; "≥ $4.20" when a call could not
 * be priced) and the average per successful run. Null when there is no cost to
 * show: no run with a cost, or a deployment without model prices (a lower
 * bound of zero says nothing).
 */
export function statsSpend(stats: Pick<TaskStats, 'totals' | 'avgCostPerSuccessUsd'>): { value: string; detail: string | null } | null {
  const { costUsd, costKnown } = stats.totals;
  if (costUsd === null || (costUsd <= 0 && !costKnown)) return null;
  const value = formatCost(costUsd, costKnown);
  if (!value) return null;
  const avg = stats.avgCostPerSuccessUsd === null ? null : formatCost(stats.avgCostPerSuccessUsd, costKnown);
  return { value, detail: avg ? `avg ${avg} per successful run` : null };
}

/** "Stopped: cost budget" for a run a budget or a stall stopped; null for any other end. */
export function stoppedWords(stopReason: string | null | undefined): string | null {
  if (!stopReason) return null;
  return stopReason.startsWith('budget_') || stopReason === 'stalled' ? `Stopped: ${stopReasonLabel(stopReason)}` : null;
}

/** The chart's rows: one per day of the period, oldest first; `last` keeps only the newest days (a phone). */
export function chartDays(series: TaskStats['series'], last?: number): TaskStats['series'] {
  return last && series.length > last ? series.slice(series.length - last) : series;
}

/** "Nov 3" for a `YYYY-MM-DD` day (a calendar day: no zone conversion). */
export function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** The schedule the header's subtitle describes: the enabled one that fires next. */
export function nextSchedule(summary: TaskSummary): TaskSummary['schedules'][number] | null {
  const enabled = summary.schedules.filter((s) => s.enabled && s.nextRunAt);
  if (enabled.length === 0) return null;
  return enabled.find((s) => s.nextRunAt === summary.nextRunAt) ?? [...enabled].sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!))[0]!;
}

/** Characters a phone fits on one line of the goal, for the "longer than six lines" estimate. */
const PHONE_LINE_CHARS = 42;
/** A goal longer than this many lines starts collapsed on a phone. */
export const GOAL_COLLAPSE_LINES = 6;

/** Whether the goal is longer than six lines on a phone (wrapped lines counted). */
export function goalIsLong(goal: string): boolean {
  const lines = goal.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / PHONE_LINE_CHARS)), 0);
  return lines > GOAL_COLLAPSE_LINES;
}
