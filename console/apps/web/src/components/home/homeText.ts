// The words of the Home page (#430): pure functions, so each is tested alone.
import { zonedDateKey } from '@marinoscar/platform-web/timezone/headless';

import type { HomeActivity, HomeLiveRun, HomeRecentRun, HomeSummary } from '../../types/home';
import { formatDateTime, formatRelative } from '../../ui';
import { describeActivity, type RunActivity } from '../RunActivity';
import { taskPaths } from '../taskList';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Good morning" before noon, "Good afternoon" before 18:00, else "Good evening", by the clock of `timeZone`. */
export function greeting(now: Date | number, timeZone: string): string {
  let hour = new Date(now).getHours();
  try {
    hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(new Date(now)));
  } catch {
    // A zone the runtime does not know: the browser's clock.
  }
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

/** The first word of a display name; null when there is none. */
export function firstName(displayName: string | null | undefined): string | null {
  const first = displayName?.trim().split(/\s+/)[0];
  return first ? first : null;
}

const agents = (n: number, verb: [string, string]) => `${n} ${n === 1 ? 'agent' : 'agents'} ${n === 1 ? verb[0] : verb[1]}`;

/**
 * The one line under the greeting: "2 agents are running and 1 is waiting for
 * you." / "Nothing is running. Next: Morning report in 3 h." / "All quiet."
 */
export function statusSentence(s: HomeSummary, now: Date | number, timeZone: string): string {
  if (!s.needsYou && !s.liveRuns && !s.upcoming && !s.recentRuns) return 'Ask an administrator for access to tasks and runs.';
  const running = s.liveRuns?.running ?? 0;
  const waiting = s.needsYou?.count ?? 0;
  const queued = Math.max(0, (s.liveRuns?.count ?? 0) - running - (s.liveRuns?.items.filter((r) => r.status === 'waiting_human').length ?? 0));
  if (running > 0 && waiting > 0) return `${agents(running, ['is', 'are'])} running and ${waiting} ${waiting === 1 ? 'is' : 'are'} waiting for you.`;
  if (running > 0) return `${agents(running, ['is', 'are'])} running.`;
  if (waiting > 0) return `${agents(waiting, ['is', 'are'])} waiting for you.`;
  if (queued > 0) return `${queued} ${queued === 1 ? 'run is' : 'runs are'} waiting for a machine.`;
  const next = s.upcoming?.items[0];
  if (next) return `Nothing is running. Next: ${next.taskName} ${formatRelative(next.nextRunAt, now, { timeZone })}.`;
  return 'All quiet.';
}

/** "4 min left", "45 s left", "2 h left"; "expired" once the moment has passed. */
export function timeLeft(expiresAt: string, now: number): string {
  const ms = Date.parse(expiresAt) - now;
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'expired';
  if (ms < MINUTE) return `${Math.ceil(ms / 1000)} s left`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min left`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h left`;
  return `${Math.floor(ms / DAY)} d left`;
}

/** A length of time in one unit: "45 s", "2 min", "3 h". */
export function shortDuration(ms: number): string {
  const v = Math.max(0, ms);
  if (v < MINUTE) return `${Math.floor(v / 1000)} s`;
  if (v < HOUR) return `${Math.floor(v / MINUTE)} min`;
  return `${Math.floor(v / HOUR)} h`;
}

/** What a live run's card says it is doing. */
export function liveLine(run: HomeLiveRun): string {
  if (run.status === 'waiting_human') return 'Waiting for your answer';
  if (run.status === 'queued') return 'Waiting for a machine';
  return run.activity ? activityLine(run.activity) : 'Working';
}

/** The run page's wording (`describeActivity`), from the summary's argument-free activity. */
export function activityLine(a: HomeActivity): string {
  if (!['starting', 'looking', 'thinking', 'acting'].includes(a.phase)) return 'Working';
  const line = describeActivity({ phase: a.phase as RunActivity['phase'], startedAt: a.startedAt ?? '', ...(a.action ? { action: a.action } : {}) });
  return a.reason && a.phase === 'acting' ? `${line} · ${a.reason}` : line;
}

/** "step 12 · 2 min": how far a live run is. */
export function progressLine(run: HomeLiveRun, now: number): string {
  const started = run.startedAt ? Date.parse(run.startedAt) : NaN;
  const steps = `step ${run.stepCount}`;
  return Number.isNaN(started) ? steps : `${steps} · ${shortDuration(now - started)}`;
}

/** The budget bar's colour: error at 100 %, warning from the policy's threshold (80 % when the run names none). */
export function budgetColor(percent: number, warnAt: number | null): 'primary' | 'warning' | 'error' {
  if (percent >= 100) return 'error';
  return percent >= (warnAt ?? 80) ? 'warning' : 'primary';
}

/** True when the run is on a stronger tier than its policy starts on. */
export function escalated(run: Pick<HomeLiveRun, 'currentTier' | 'startTier'>): boolean {
  return run.currentTier !== null && run.startTier !== null && run.currentTier !== run.startTier;
}

/** "Today 17:00 · in 3 h", "Tomorrow 09:00", "Sat, Nov 21 09:00". */
export function upNextWhen(iso: string, now: Date | number, timeZone: string): string {
  const opts = { timeZone };
  const at = new Date(iso);
  const clock = formatDateTime(at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...opts });
  const key = (d: Date | number) => zonedDateKey(new Date(d), timeZone);
  const day = key(at);
  const relative = formatRelative(at, now, opts);
  const suffix = relative.startsWith('in ') || relative === 'just now' ? ` · ${relative}` : '';
  if (day !== null && day === key(now)) return `Today ${clock}${suffix}`;
  if (day !== null && day === key(new Date(now).getTime() + DAY)) return `Tomorrow ${clock}${suffix}`;
  const date = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...opts }).format(at);
  return `${date} ${clock}`;
}

/** How long a finished run took; null when it never started. */
export function runDuration(run: Pick<HomeRecentRun, 'startedAt' | 'finishedAt'>): string | null {
  if (!run.startedAt || !run.finishedAt) return null;
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  return Number.isNaN(ms) ? null : shortDuration(ms);
}

/** "92 %"; "n/a" with no finished run. */
export function successRate(rate: number | null): string {
  return rate === null ? 'n/a' : `${Math.round(rate * 100)} %`;
}

/** The Runs page with its "New run" dialog open (`RunsPage` reads `new=1` and drops it). */
export const NEW_RUN_LINK = '/runs?new=1';

/**
 * The Runs page, on the week's failed runs: `/runs?view=failed&from=<first day>` (and `&stopReason=`).
 * The parameters are the runs list's own (`filtersFromParams` in components/runFilters.ts).
 */
export function weekRunsLink(from: string, stopReason?: 'budget' | 'stalled'): string {
  const params = new URLSearchParams({ view: 'failed' });
  if (stopReason) params.set('stopReason', stopReason);
  params.set('from', from);
  return `/runs?${params.toString()}`;
}

/** The tasks the user ran most recently, newest first, each once: the Quick start chips. */
export function recentTasks(s: HomeSummary, max = 4): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  const rows = [...(s.liveRuns?.items ?? []), ...(s.recentRuns?.items ?? [])];
  for (const r of rows) if (r.taskId && r.taskName && !seen.has(r.taskId)) seen.set(r.taskId, r.taskName);
  return [...seen].slice(0, max).map(([id, name]) => ({ id, name }));
}

/** The three first-run steps the viewer can see, each ticked from the data. */
export interface ChecklistStep {
  key: 'machine' | 'task' | 'run';
  label: string;
  to: string;
  done: boolean;
}

export function checklistSteps(s: HomeSummary, can: (permission: string) => boolean): ChecklistStep[] {
  const steps: ChecklistStep[] = [];
  // A stale fleet with no host is "unknown", not "none": it never brings the checklist back.
  if (s.fleet) steps.push({ key: 'machine', label: 'Connect a machine', to: '/fleet', done: s.fleet.total > 0 || s.fleet.stale });
  if (s.counts.tasks !== null && can('tasks:write')) steps.push({ key: 'task', label: 'Create a task', to: taskPaths.create, done: s.counts.tasks > 0 });
  if (s.counts.runs !== null && can('runs:write')) steps.push({ key: 'run', label: 'Run it', to: taskPaths.list, done: s.counts.runs > 0 });
  return steps;
}

/** The checklist shows until every step it has is done. */
export function needsChecklist(steps: ChecklistStep[]): boolean {
  return steps.length > 0 && steps.some((step) => !step.done);
}
