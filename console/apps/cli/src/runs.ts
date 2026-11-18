// Deleting runs and paging the run list from the CLI and the TUI (#432), over
// `DELETE /runs/:id`, `POST /runs/delete`, `GET /runs/counts` and the
// `envelope=1` form of `GET /runs`. No I/O of its own beyond the API client
// it is given, so each piece is tested with a fake fetch.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

/** `1.2 MB`, `340 KB`, `512 B`. */
export function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** The file name the console suggests (`Content-Disposition`), or `hexactra-run-<first 8 of id>-<yyyymmdd>.json`. */
export function exportFilename(id: string, disposition: string | null, now: Date = new Date()): string {
  const named = disposition ? /filename="([^"/\\]+)"/.exec(disposition)?.[1] : undefined;
  return named ?? `hexactra-run-${id.slice(0, 8)}-${now.toISOString().slice(0, 10).replace(/-/g, '')}.json`;
}

/**
 * `hexactra runs export <id>` (#542): the run's masked JSON trace file from
 * `GET /runs/{id}/export`, written to `output` (default: the console's file
 * name in `dir`, the current directory). On an error no file is written.
 */
export async function exportRun(api: ApiClient, id: string, opts: { screenshots: boolean; output?: string; dir?: string }): Promise<{ path: string; bytes: number }> {
  let res: Awaited<ReturnType<ApiClient['send']>>;
  try {
    // A file with embedded screenshots can take a while to build and download.
    res = await api.send<unknown>('GET', `/runs/${encodeURIComponent(id)}/export`, { query: { format: 'json', screenshots: opts.screenshots ? 'embed' : 'none' }, timeoutMs: 180_000 });
  } catch (e) {
    const status = (e as { status?: unknown }).status;
    const code = (e as { code?: unknown }).code;
    if (status === 404) throw new Error(`Run ${id} was not found: no run of yours has this id (hexactra runs list shows them).`);
    if (status === 400) throw new Error(`"${id}" is not a run id: pass the full id (hexactra runs list --json shows it).`);
    if (code === 'EXPORT_TOO_LARGE') throw new Error(`The file of run ${id} would be over 50 MB with its screenshots: export it with --no-screenshots.`);
    throw e;
  }
  const text = `${JSON.stringify(res.body, null, 2)}\n`;
  const path = resolve(opts.dir ?? process.cwd(), opts.output ?? exportFilename(id, res.headers.get('content-disposition')));
  writeFileSync(path, text);
  return { path, bytes: Buffer.byteLength(text) };
}
