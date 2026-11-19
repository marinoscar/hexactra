// What the tasks card reads from a tool result (#467): the rows of
// `tasks_list` (each task with the summary fields: schedule in words, next
// run, last run, paused, live run), a task as `task_pause` / `task_resume`
// answer it (the REST task with its `summary`), and the run `task_run` starts.
import { scopesOf } from './shared/scopes';
import { obj, str, structured, type ToolResultLike } from './shared/text';

/** The only server tools this bundle calls (scripts/check-bundle.mjs checks the built file names no other). */
export const TASKS_CARD_TOOLS = ['tasks_list', 'task_run', 'task_pause', 'task_resume'] as const;
export type TasksCardTool = (typeof TASKS_CARD_TOOLS)[number];

/** Rows shown at a time ("Show more" adds as many). */
export const PAGE_ROWS = 20;

export interface TaskRow {
  id: string;
  name: string;
  goal: string;
  scheduleState: 'none' | 'active' | 'paused' | 'partial';
  scheduleText: string | null;
  nextRunAt: string | null;
  lastRun: { id: string; status: string; finishedAt: string | null } | null;
  liveRunId: string | null;
}

export interface TasksResult {
  rows: TaskRow[];
  nextCursor: string | null;
  total: number | null;
  appUrl?: string;
  scopes: string[] | null;
  /** Opened by schedules_list: the card loads the tasks itself and shows the scheduled ones. */
  fromSchedules: boolean;
}

const STATES = new Set(['none', 'active', 'paused', 'partial']);

function lastRunOf(v: unknown): TaskRow['lastRun'] {
  const l = obj(v);
  return l && typeof l.id === 'string' && typeof l.status === 'string' ? { id: l.id, status: l.status, finishedAt: str(l.finishedAt) ?? null } : null;
}

/** One row: from tasks_list's flattened item, or from a REST task with its `summary` (task_pause, task_resume). */
export function rowOf(v: unknown): TaskRow | undefined {
  const t = obj(v);
  if (!t || typeof t.id !== 'string') return undefined;
  const s = obj(t.summary);
  if (s) {
    const schedules = Array.isArray(s.schedules) ? s.schedules.map(obj).filter((x): x is Record<string, unknown> => x !== undefined) : [];
    const enabled = schedules.filter((x) => x.enabled === true).map((x) => str(x.description) ?? '');
    const state = STATES.has(String(s.scheduleState)) ? (s.scheduleState as TaskRow['scheduleState']) : 'none';
    return {
      id: t.id,
      name: str(t.name) ?? '',
      goal: str(t.goal) ?? '',
      scheduleState: state,
      scheduleText: !schedules.length ? null : enabled.length ? `${enabled.slice(0, 2).join('; ')}${enabled.length > 2 ? ` and ${enabled.length - 2} more` : ''}` : 'Paused',
      nextRunAt: str(s.nextRunAt) ?? null,
      lastRun: lastRunOf(s.lastRun),
      liveRunId: str(s.liveRunId) ?? null,
    };
  }
  return {
    id: t.id,
    name: str(t.name) ?? '',
    goal: str(t.goal) ?? '',
    scheduleState: STATES.has(String(t.scheduleState)) ? (t.scheduleState as TaskRow['scheduleState']) : t.paused === true ? 'paused' : 'none',
    scheduleText: str(t.scheduleText) ?? null,
    nextRunAt: str(t.nextRunAt) ?? null,
    lastRun: lastRunOf(t.lastRun),
    liveRunId: str(t.liveRunId) ?? null,
  };
}

/** A tool result as the card's data, or `undefined`. A schedules_list result has schedules, not tasks: `fromSchedules`. */
export function tasksResultOf(r: ToolResultLike | undefined | null): TasksResult | undefined {
  if (!r || r.isError) return undefined;
  const s = structured(r);
  if (!s || !Array.isArray(s.items)) return undefined;
  const common = { scopes: scopesOf(s), ...(str(s.app_url) ? { appUrl: str(s.app_url) } : {}) };
  // A schedule names its task (`taskId`) and has a cron expression; a task does not.
  // tasks_list always answers `total`; schedules_list answers schedules only.
  const schedules = s.items.length > 0 ? s.items.every((x) => typeof obj(x)?.taskId === 'string' && typeof obj(x)?.cron === 'string') : typeof s.total !== 'number';
  if (schedules) return { rows: [], nextCursor: null, total: null, fromSchedules: true, ...common };
  const rows = s.items.map(rowOf).filter((x): x is TaskRow => x !== undefined);
  return { rows, nextCursor: str(s.next_cursor) ?? null, total: typeof s.total === 'number' ? s.total : null, fromSchedules: false, ...common };
}

/** The run a task_run result started: its id and status, or `undefined`. */
export function startedRun(r: ToolResultLike | undefined | null): { id: string; status: string } | undefined {
  if (!r || r.isError) return undefined;
  const s = structured(r);
  if (!s || typeof s.id !== 'string') return undefined;
  const p = obj(s.progress);
  return { id: s.id, status: str(p?.status) ?? str(s.status) ?? 'queued' };
}

/** The last run's status in words, for its chip. */
export const RUN_STATUS_LABEL: Readonly<Record<string, string>> = {
  queued: 'Queued',
  running: 'Running',
  waiting_human: 'Needs you',
  paused: 'Paused',
  succeeded: 'Finished',
  failed: 'Failed',
  cancelled: 'Stopped',
};

/** A date as "Tue 18 Nov, 09:00" in the viewer's locale, or `null`. */
export function whenText(iso: string | null, locale?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
