/**
 * Active-time accounting for a run (#399). A run's time budget counts only
 * the time it spends in `running`; time waiting for a person never counts.
 * `runs.active_ms` holds the settled total and `runs.active_since` the moment
 * the run last entered `running` (null while it is not running).
 */
export interface ActiveClock {
  activeMs: number;
  activeSince: Date | null;
}

/** Milliseconds the run has been active at `nowMs`: the settled total plus the open stretch. */
export function activeElapsedMs(run: ActiveClock, nowMs: number): number {
  const open = run.activeSince ? Math.max(0, nowMs - run.activeSince.getTime()) : 0;
  return run.activeMs + open;
}


/** Whether the run's active time has passed its budget in minutes. */
export function timeBudgetExhausted(run: ActiveClock, maxMinutes: number, nowMs: number): boolean {
  return activeElapsedMs(run, nowMs) > maxMinutes * 60_000;
}
