// The runs list's filters (#423): their URL form, the query they become on
// `GET /runs` and `GET /runs/counts`, the body they become on a delete by
// filter, and the same test on the client (a new live run joins the list only
// when the active filter would include it). Pure: no React, no fetch.
import { getTimeZoneOffsetMinutes, zonedDateKey } from '@marinoscar/platform-web/timezone/headless';

import { RUN_TRIGGERS, type RunCounts, type RunListItem, type RunStatus, type RunTrigger } from '../types/runs';

/** The status tabs, in the order they show. */
export const RUN_VIEWS = ['all', 'live', 'needs', 'succeeded', 'failed', 'cancelled'] as const;
export type RunView = (typeof RUN_VIEWS)[number];

export const RUN_VIEW_LABEL: Record<RunView, string> = {
  all: 'All',
  live: 'Live',
  needs: 'Needs you',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** The "Stopped by" choices: `budget` is every `budget_*` stop reason. */
export const STOP_FILTERS = ['budget', 'stalled', 'error', 'no_model'] as const;
export type StopFilter = (typeof STOP_FILTERS)[number];

export const STOP_FILTER_LABEL: Record<StopFilter, string> = { budget: 'Budget', stalled: 'Stalled', error: 'Error', no_model: 'No model' };

export const TRIGGER_LABEL: Record<RunTrigger, string> = { manual: 'Manual', schedule: 'Schedule', api: 'API', mcp: 'MCP', external: 'External agent', chat: 'Chat' };

/** The date presets: a number of days back from today (0: today). */
export const DATE_PRESETS = [
  { key: 'today', label: 'Today', days: 0 },
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
] as const;
export type DatePresetKey = (typeof DATE_PRESETS)[number]['key'];

/** Everything the list can be filtered by. */
export interface RunFilters {
  view: RunView;
  /** A substring of the goal. */
  q: string;
  /** A task's id, `none` for runs without a task, or null. */
  taskId: string | null;
  trigger: RunTrigger[];
  /** The first day (`YYYY-MM-DD`, a calendar day of the profile time zone), or null. */
  from: string | null;
  /** The last day, inclusive, or null. */
  to: string | null;
  stopReason: StopFilter[];
  /** An agent policy's id (`builtin:<key>` or a UUID), or null. */
  policyId: string | null;
}

export const NO_FILTERS: RunFilters = { view: 'all', q: '', taskId: null, trigger: [], from: null, to: null, stopReason: [], policyId: null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function list<T extends string>(raw: string | null, allowed: readonly T[]): T[] {
  if (!raw) return [];
  const seen = new Set(raw.split(',').map((v) => v.trim()));
  return allowed.filter((v) => seen.has(v));
}

/** "Stopped by" applies to runs that can have failed: the All and Failed tabs. */
export function showsStopFilter(view: RunView): boolean {
  return view === 'all' || view === 'failed';
}

/** The filters a URL carries; a value the list does not know is dropped. */
export function filtersFromParams(params: URLSearchParams): RunFilters {
  const view = params.get('view');
  const taskId = params.get('taskId');
  const from = params.get('from');
  const to = params.get('to');
  const policyId = params.get('policyId')?.trim();
  return {
    view: (RUN_VIEWS as readonly string[]).includes(view ?? '') ? (view as RunView) : 'all',
    q: (params.get('q') ?? '').slice(0, 200),
    taskId: taskId && (taskId === 'none' || UUID.test(taskId)) ? taskId : null,
    trigger: list(params.get('trigger'), RUN_TRIGGERS),
    from: from && DAY.test(from) ? from : null,
    to: to && DAY.test(to) ? to : null,
    stopReason: list(params.get('stopReason'), STOP_FILTERS),
    policyId: policyId ? policyId : null,
  };
}

const FILTER_KEYS = ['view', 'q', 'taskId', 'trigger', 'from', 'to', 'stopReason', 'policyId'] as const;

/** `params` with the filters written into it; a parameter that is not a filter is kept. */
export function filtersToParams(filters: RunFilters, params: URLSearchParams = new URLSearchParams()): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of FILTER_KEYS) next.delete(key);
  if (filters.view !== 'all') next.set('view', filters.view);
  if (filters.q.trim()) next.set('q', filters.q.trim());
  if (filters.taskId) next.set('taskId', filters.taskId);
  if (filters.trigger.length) next.set('trigger', filters.trigger.join(','));
  if (filters.from) next.set('from', filters.from);
  if (filters.to) next.set('to', filters.to);
  if (filters.stopReason.length) next.set('stopReason', filters.stopReason.join(','));
  if (filters.policyId) next.set('policyId', filters.policyId);
  return next;
}

/** The filters that narrow the list beyond its tab, counted for the "Filters (2)" button. A fixed task (`scoped`) is not one. */
export function activeFilterCount(filters: RunFilters, scoped = false): number {
  return (
    (filters.q.trim() ? 1 : 0) +
    (filters.taskId && !scoped ? 1 : 0) +
    (filters.trigger.length ? 1 : 0) +
    (filters.from || filters.to ? 1 : 0) +
    (filters.stopReason.length && showsStopFilter(filters.view) ? 1 : 0) +
    (filters.policyId ? 1 : 0)
  );
}

// ---- Days of the profile time zone ----

/** The instant a calendar day begins in `timeZone`. */
export function startOfDay(day: string, timeZone: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const utc = Date.UTC(y, m - 1, d);
  // The zone's offset at the guess, then at the corrected instant (a day that begins across a clock change).
  let at = utc - getTimeZoneOffsetMinutes(timeZone, new Date(utc)) * 60_000;
  at = utc - getTimeZoneOffsetMinutes(timeZone, new Date(at)) * 60_000;
  return new Date(at);
}

/** The calendar day `days` after `day` (negative: before). */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Today in `timeZone`, as `YYYY-MM-DD`. */
export function today(timeZone: string, now: Date | number = Date.now()): string {
  return zonedDateKey(now, timeZone) ?? new Date(now).toISOString().slice(0, 10);
}

/** The `from` day of a preset: today, or that many days back. */
export function presetFrom(key: DatePresetKey, timeZone: string, now: Date | number = Date.now()): string {
  const preset = DATE_PRESETS.find((p) => p.key === key)!;
  return addDays(today(timeZone, now), -preset.days);
}

/** The preset a `from`/`to` pair is, `custom` for any other range, null for none. */
export function presetOf(filters: Pick<RunFilters, 'from' | 'to'>, timeZone: string, now: Date | number = Date.now()): DatePresetKey | 'custom' | null {
  if (!filters.from && !filters.to) return null;
  if (filters.to || !filters.from) return 'custom';
  return DATE_PRESETS.find((p) => presetFrom(p.key, timeZone, now) === filters.from)?.key ?? 'custom';
}

/** The range as ISO instants: `from` inclusive, `to` exclusive (the day after the last day). */
export function rangeInstants(filters: Pick<RunFilters, 'from' | 'to'>, timeZone: string): { from?: string; to?: string } {
  return {
    ...(filters.from ? { from: startOfDay(filters.from, timeZone).toISOString() } : {}),
    ...(filters.to ? { to: startOfDay(addDays(filters.to, 1), timeZone).toISOString() } : {}),
  };
}

// ---- The API's form ----

const VIEW_STATUS: Partial<Record<RunView, RunStatus>> = { needs: 'waiting_human', succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled' };

/** `scope.taskId` fixes the task: the list of one task's runs (the task page). */
export interface RunListScope {
  taskId?: string;
}

/**
 * The run filter as the API takes it (`runFilterSchema`): the body of a delete
 * by filter, and the source of the list's and the counts' query strings.
 * `withStatus: false` leaves the tab out (the counts are per status).
 */
export function apiFilter(filters: RunFilters, scope: RunListScope, timeZone: string, withStatus = true): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (withStatus) {
    if (filters.view === 'live') out.state = 'live';
    const status = VIEW_STATUS[filters.view];
    if (status) out.status = [status];
  }
  const taskId = scope.taskId ?? filters.taskId;
  if (taskId) out.taskId = taskId;
  if (filters.trigger.length) out.trigger = [...filters.trigger];
  Object.assign(out, rangeInstants(filters, timeZone));
  if (filters.q.trim()) out.q = filters.q.trim();
  if (filters.stopReason.length && showsStopFilter(filters.view)) out.stopReason = [...filters.stopReason];
  if (filters.policyId) out.policyId = filters.policyId;
  return out;
}

/** A filter as a query string (no leading `?`); lists are comma-separated. */
export function toQuery(filter: Record<string, string | string[]>, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  for (const [key, value] of Object.entries(filter)) params.set(key, Array.isArray(value) ? value.join(',') : value);
  return params.toString();
}

/**
 * The body filter of "delete every finished run that matches": the same
 * filter, restricted to finished runs. The API never deletes a live run.
 */
export function deleteFilter(filters: RunFilters, scope: RunListScope, timeZone: string): Record<string, string | string[]> {
  const filter = apiFilter(filters, scope, timeZone);
  delete filter.state;
  if (!filter.status) filter.state = 'finished';
  return filter;
}

const LIVE: readonly RunStatus[] = ['queued', 'running', 'waiting_human'];

/** How many runs a tab holds, from the counts. */
export function viewCount(counts: RunCounts | null, view: RunView): number | null {
  if (!counts) return null;
  if (view === 'all') return counts.total;
  if (view === 'live') return counts.live;
  return counts.byStatus[VIEW_STATUS[view]!] ?? 0;
}

/** The finished runs the tab holds: what "select all that match" would delete. */
export function finishedCount(counts: RunCounts | null, view: RunView): number {
  if (!counts || view === 'live' || view === 'needs') return 0;
  if (view === 'all') return counts.byStatus.succeeded + counts.byStatus.failed + counts.byStatus.cancelled;
  return counts.byStatus[VIEW_STATUS[view]!] ?? 0;
}

/** True when the run is one the filter lists: the client's copy of the server's test, for a run that arrives on a live tick. */
export function matchesFilters(run: RunListItem, filters: RunFilters, scope: RunListScope, timeZone: string): boolean {
  if (filters.view === 'live' && !LIVE.includes(run.status)) return false;
  const status = VIEW_STATUS[filters.view];
  if (status && run.status !== status) return false;
  const taskId = scope.taskId ?? filters.taskId;
  if (taskId === 'none' ? run.taskId !== null : taskId ? run.taskId !== taskId : false) return false;
  if (filters.trigger.length && !filters.trigger.includes(run.trigger as RunTrigger)) return false;
  const q = filters.q.trim().toLowerCase();
  if (q && !run.goal.toLowerCase().includes(q)) return false;
  const { from, to } = rangeInstants(filters, timeZone);
  const created = Date.parse(run.createdAt);
  if (from && created < Date.parse(from)) return false;
  if (to && created >= Date.parse(to)) return false;
  if (filters.stopReason.length && showsStopFilter(filters.view)) {
    const reason = run.stopReason;
    if (!reason || !filters.stopReason.some((f) => (f === 'budget' ? reason.startsWith('budget_') : f === reason))) return false;
  }
  if (filters.policyId && run.policy?.id !== filters.policyId) return false;
  return true;
}
