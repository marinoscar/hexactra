// `hexactra runs dataset export` (E53.4, #1072, on the dataset of E53.3, #1071): asks the console for the run dataset (the exports
// slice's `run-dataset` source), waits until it is ready, and saves the file through its short-lived signed link. The signed link is
// fetched WITHOUT the console token: it goes to object storage, which must never see it.
import { writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import type { ApiClient } from '@marinoscar/platform-cli/api-client';

import { timeArg } from './run-stats.js';

export const DATASET_FORMATS = ['json', 'csv', 'xlsx'] as const;
export const DATASET_STATUSES = ['finished', 'succeeded', 'failed', 'cancelled', 'all'] as const;

export interface DatasetFlags {
  from?: string;
  to?: string;
  status?: string;
  stopReason?: string;
  trigger?: string;
  steps?: boolean;
  format?: string;
}

export interface ExportView {
  id: string;
  status: 'pending' | 'running' | 'ready' | 'expired' | 'failed';
  fileName: string | null;
  sizeBytes: number | null;
  rowCounts: Record<string, number> | null;
  error: string | null;
  download: { url: string; expiresAt: string } | null;
}

/** A day for the request: `7d`/`24h`/`2w` back from now, or a date; the console cuts days in your time zone. */
export function dayArg(value: string, now = Date.now()): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
  return timeArg(value, now).slice(0, 10);
}

/** The body of `POST /api/exports`. `taskId` is resolved by the command. */
export function datasetBody(flags: DatasetFlags, taskId?: string, now = Date.now()): { source: 'run-dataset'; format: string; request: Record<string, unknown> } {
  const format = flags.format ?? 'json';
  if (!(DATASET_FORMATS as readonly string[]).includes(format)) throw new Error(`--format must be one of: ${DATASET_FORMATS.join(', ')}`);
  const status = flags.status ?? 'finished';
  if (!(DATASET_STATUSES as readonly string[]).includes(status)) throw new Error(`--status must be one of: ${DATASET_STATUSES.join(', ')}`);
  const request: Record<string, unknown> = { status, includeSteps: Boolean(flags.steps) };
  if (flags.from) request.from = dayArg(flags.from, now);
  if (flags.to) request.to = dayArg(flags.to, now);
  if (taskId) request.taskId = taskId;
  if (flags.stopReason) request.stopReason = flags.stopReason;
  if (flags.trigger) request.trigger = flags.trigger;
  return { source: 'run-dataset', format, request };
}

export interface ExportOptions {
  /** Where to write; default the console's file name in the current directory. */
  output?: string;
  /** How long to wait for the file. */
  waitMs: number;
  pollMs: number;
  sleep: (ms: number) => Promise<void>;
  /** The fetch for the signed link: a plain one, never the console client. */
  fetchFile: (url: string) => Promise<Response>;
}

/** Start the export, wait for it, save it. Throws with the console's fixed message when it failed or expired. */
export async function exportDataset(api: ApiClient, body: ReturnType<typeof datasetBody>, o: ExportOptions): Promise<{ path: string; bytes: number; rowCounts: Record<string, number>; id: string }> {
  const started = await api.post<ExportView>('/exports', body);
  const until = Date.now() + o.waitMs;
  let view = started;
  while (view.status === 'pending' || view.status === 'running') {
    if (Date.now() > until) throw new Error(`The dataset is still being made (export ${started.id}). Check it later with: hexactra runs dataset status ${started.id}`);
    await o.sleep(o.pollMs);
    view = await api.get<ExportView>(`/exports/${started.id}`);
  }
  if (view.status !== 'ready' || !view.download) throw new Error(`The dataset was not made (${view.status}): ${view.error ?? 'no file'}`);
  const res = await o.fetchFile(view.download.url);
  if (!res.ok) throw new Error(`Downloading the dataset failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const path = resolve(o.output ?? basename(view.fileName ?? `hexactra-runs.${body.format === 'csv' ? 'zip' : body.format}`));
  writeFileSync(path, bytes);
  return { path, bytes: bytes.length, rowCounts: view.rowCounts ?? {}, id: view.id };
}
