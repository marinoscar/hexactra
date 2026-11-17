// Deleting runs and paging the run list from the CLI and the TUI (#432), over
// `DELETE /runs/:id`, `POST /runs/delete`, `GET /runs/counts` and the
// `envelope=1` form of `GET /runs`. No I/O of its own beyond the API client
// it is given, so each piece is tested with a fake fetch.
import type { ApiClient } from '@marinoscar/platform-cli/api-client';

/** `GET /runs?envelope=1`. */
export interface RunPage<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * The list a screen shows: the first page (re-read on every refresh), then the
 * older pages loaded with "more", without the rows the first page now holds
 * (a new run pushes one row from the first page into the second).
 */
export function mergeRunPages<T extends { id: string }>(head: readonly T[], older: readonly T[]): T[] {
  const seen = new Set(head.map((r) => r.id));
  const rest: T[] = [];
  for (const r of older) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    rest.push(r);
  }
  return [...head, ...rest];
}

/** `--older-than <days>`: a whole number of days, at least 1. */
export function parseDays(raw: string): number {
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) throw new Error(`--older-than takes a whole number of days, 1 or more (got "${raw}").`);
  return days;
}

/** The instant `days` days before `now`, as the `to` of a run filter (runs created before it). */
export function olderThanInstant(days: number, now: number = Date.now()): string {
  return new Date(now - days * 24 * 60 * 60_000).toISOString();
}

interface Counts {
  byStatus: { succeeded: number; failed: number; cancelled: number };
  costUsd: number | null;
}
type DeleteResult = { deleted: number; costUsd: number | null; skippedLive: string[]; notFound: string[] } | { jobId: string; matched: number; costUsd: number | null };

/** How many finished runs are older than `days` days, and the filter that selects them. A live run is never counted or deleted. */
export async function countOlderThan(api: ApiClient, days: number, now: number = Date.now()): Promise<{ filter: { to: string }; matched: number; costUsd: number | null }> {
  const filter = { to: olderThanInstant(days, now) };
  const counts = await api.get<Counts>('/runs/counts', { query: filter });
  const { succeeded, failed, cancelled } = counts.byStatus;
  return { filter, matched: succeeded + failed + cancelled, costUsd: counts.costUsd };
}

/**
 * Delete what `countOlderThan` counted. `expectedCount` makes the API refuse
 * (409 COUNT_CHANGED) when the match moved by more than 5 % since the count.
 * Returns what to print.
 */
export async function deleteOlderThan(api: ApiClient, filter: { to: string }, expectedCount: number): Promise<string> {
  const result = await api.post<DeleteResult>('/runs/delete', { filter, expectedCount });
  if ('jobId' in result) return `Deleting ${runsWord(result.matched)} in the background (job ${result.jobId}).`;
  return `Deleted ${runsWord(result.deleted)}.`;
}

/** "3 runs", "1 run". */
export function runsWord(n: number): string {
  return `${n} run${n === 1 ? '' : 's'}`;
}
