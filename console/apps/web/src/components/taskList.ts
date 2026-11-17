// The Tasks list (#426) without React: its query (URL state and request
// path), the routes its rows link to, and the words of a row.
import type { TaskSpend } from './runBudget';
import type { TaskListFilter, TaskListSort, TaskSummary } from '../types/tasks';
import { formatCost } from '../ui';

/** Rows per request. */
export const TASK_PAGE_SIZE = 50;

/** What the list asks for: the toolbar's state, kept in the URL (`?q=&filter=&sort=&policyId=`). */
export interface TaskListQuery {
  q: string;
  filter: TaskListFilter | null;
  sort: TaskListSort;
  /** A policy reference (a UUID, `builtin:<key>`) or `default`; null is every policy. */
  policyId: string | null;
}

export const DEFAULT_TASK_SORT: TaskListSort = 'created_desc';

/** The filter chips, in order; `null` is "All". */
export const TASK_FILTERS: ReadonlyArray<{ value: TaskListFilter | null; label: string }> = [
  { value: null, label: 'All' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'paused', label: 'Paused' },
  { value: 'unscheduled', label: 'Not scheduled' },
  { value: 'failing', label: 'Failing' },
  { value: 'never_run', label: 'Never run' },
];

/** The sort choices, in order. */
export const TASK_SORTS: ReadonlyArray<{ value: TaskListSort; label: string }> = [
  { value: 'created_desc', label: 'Newest' },
  { value: 'name_asc', label: 'Name' },
  { value: 'last_run_desc', label: 'Last run' },
  { value: 'next_run_asc', label: 'Next run' },
  { value: 'spend_desc', label: 'Spend' },
];

/** The query a URL holds; an unknown filter or sort reads as the default. */
export function parseTaskListQuery(params: URLSearchParams): TaskListQuery {
  const filter = params.get('filter');
  const sort = params.get('sort');
  return {
    q: params.get('q') ?? '',
    filter: TASK_FILTERS.some((f) => f.value !== null && f.value === filter) ? (filter as TaskListFilter) : null,
    sort: TASK_SORTS.some((s) => s.value === sort) ? (sort as TaskListSort) : DEFAULT_TASK_SORT,
    policyId: params.get('policyId') || null,
  };
}

/** The URL's search params for a query; a default is left out. */
export function taskListSearchParams(query: TaskListQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.q.trim()) params.set('q', query.q.trim());
  if (query.filter) params.set('filter', query.filter);
  if (query.sort !== DEFAULT_TASK_SORT) params.set('sort', query.sort);
  if (query.policyId) params.set('policyId', query.policyId);
  return params;
}

/** True when the query narrows the list (the "no match" state, as opposed to "no tasks yet"). */
export function isFiltered(query: TaskListQuery): boolean {
  return query.q.trim() !== '' || query.filter !== null || query.policyId !== null;
}

/** `GET /tasks?envelope=1&include=summary&…` for one page of a query. */
export function taskListPath(query: TaskListQuery, limit: number = TASK_PAGE_SIZE, cursor?: string | null): string {
  const params = new URLSearchParams({ envelope: '1', include: 'summary', limit: String(limit) });
  if (query.q.trim()) params.set('q', query.q.trim());
  if (query.filter) params.set('filter', query.filter);
  params.set('sort', query.sort);
  if (query.policyId) params.set('policyId', query.policyId);
  if (cursor) params.set('cursor', cursor);
  return `/tasks?${params.toString()}`;
}

/**
 * Where a task's links go. The task page (`/tasks/:id`) arrives with #428;
 * until then App.tsx redirects that address to the list, and `runs` is the
 * Runs page filtered to the task (#428 points it at `/tasks/:id#runs`).
 */
export const taskPaths = {
  list: '/tasks',
  create: '/tasks/new',
  /** A new task that starts from a goal (the empty state's examples). */
  createFromGoal: (goal: string) => `/tasks/new?goal=${encodeURIComponent(goal)}`,
  /** A new task that starts as a copy of another (#427 reads `from`). */
  duplicate: (id: string) => `/tasks/new?from=${id}`,
  edit: (id: string) => `/tasks/${id}/edit`,
  /** The edit page, at its schedules. */
  editSchedule: (id: string) => `/tasks/${id}/edit#schedule`,
  detail: (id: string) => `/tasks/${id}`,
  runs: (id: string) => `/runs?taskId=${id}`,
  run: (runId: string) => `/runs/${runId}`,
};

/** The example goals of the empty state. */
export const EXAMPLE_GOALS = ['Check my electricity bill and tell me the amount due', "Download last month's bank statement", 'Renew my library loans'] as const;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The 7-day strip: "12 ✓ · 1 ✗" and what it says to assistive technology; null text when there was no run. */
export function outcomeStrip(last7d: TaskSummary['runCounts']['last7d']): { text: string | null; label: string } {
  const { succeeded, failed, cancelled } = last7d;
  if (succeeded + failed + cancelled === 0) return { text: null, label: 'No runs in the last 7 days' };
  const text = [`${succeeded} ✓`, `${failed} ✗`, ...(cancelled > 0 ? [`${cancelled} ⊘`] : [])].join(' · ');
  const words = [`${succeeded} succeeded`, `${failed} failed`, ...(cancelled > 0 ? [`${cancelled} cancelled`] : [])].join(', ');
  return { text, label: `${words} in the last 7 days` };
}

/** The spend cell: "$4.20", "≥ $4.20" when part of the cost is unknown, null (a dash) at zero; the tooltip has the runs and the average. */
export function spendCell(spend: TaskSpend | null | undefined): { text: string | null; detail: string } {
  if (!spend || spend.runs === 0) return { text: null, detail: 'No runs in the last 30 days' };
  const parts = [`${spend.runs} ${plural(spend.runs, 'run', 'runs')} in the last 30 days`];
  if (typeof spend.avgSuccessCostUsd === 'number') parts.push(`${formatCost(spend.avgSuccessCostUsd, spend.costKnown)} per successful run`);
  else if (spend.succeeded === 0) parts.push('no successful run');
  // Zero that is fully priced is a dash; zero with unpriced calls is a lower bound.
  const text = spend.costUsd === 0 && spend.costKnown ? null : formatCost(spend.costUsd, spend.costKnown);
  return { text, detail: parts.join(' · ') };
}

/** What deleting a task does to its schedules and runs, for the confirm dialog. */
export function deleteTaskBody(summary: TaskSummary | undefined): string {
  if (!summary) return 'Its schedules are deleted. Its runs are kept in Runs as one-off runs.';
  const schedules = summary.schedules.length;
  const runs = summary.runCounts.total;
  const first = schedules === 0 ? 'It has no schedule.' : schedules === 1 ? 'Its schedule is deleted.' : `Its ${schedules} schedules are deleted.`;
  const second = runs === 0 ? 'It has no runs.' : runs === 1 ? 'Its run is kept in Runs as a one-off run.' : `Its ${runs.toLocaleString('en-US')} runs are kept in Runs as one-off runs.`;
  return `${first} ${second}`;
}
