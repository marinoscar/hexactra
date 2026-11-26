// Batch runs (E51.1, #1006): a saved task run once per row of values, one run after another. The shapes the API serves
// (`batchResponseSchema` in apps/api/src/openapi/console.responses.ts), the paste parser of the "Run for several" form, and
// the mapping of the API's per-row errors onto the form's rows and cells. Pure: no React, no fetch.
import { isPlatformApiError } from '@marinoscar/platform-web/core';
import type { TaskParameter } from '@app/shared/task-params';

export type BatchStatus = 'review' | 'running' | 'done' | 'cancelled';
export type BatchItemStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';
export type BatchStopReason = 'owner_stopped' | 'unknown_outcome' | 'row_failed' | 'task_deleted';

export interface BatchItem {
  /** The row, 1..n. */
  seq: number;
  status: BatchItemStatus;
  runId: string | null;
  /** The row's values, by parameter, masked by the API. */
  values: { key: string; label: string; value: string }[];
  runStatus: string | null;
  /** The first 300 characters of the run's result (or error), masked; null until it ends. */
  result: string | null;
}

export interface BatchCounts {
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  skipped: number;
  pending: number;
  running: number;
}

export interface Batch {
  id: string;
  taskId: string;
  taskName: string | null;
  conversationId: string | null;
  trigger: string;
  origin: string;
  policyRef: string | null;
  status: BatchStatus;
  total: number;
  onFailure: 'continue' | 'stop';
  stopReason: BatchStopReason | null;
  stoppedAtSeq: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  counts: BatchCounts;
  /** "3 of 3 done", "2 done, 1 failed, 2 not started". */
  summary: string;
  items: BatchItem[];
}

export interface BatchPage {
  items: Batch[];
  nextCursor: string | null;
}

/** The batch still has something to do: waiting for review, or running. */
export function isLiveBatch(status: BatchStatus | string): boolean {
  return status === 'review' || status === 'running';
}

/** How often a live batch is read again, in ms. */
export const BATCH_POLL_MS = 3_000;

/** The chip of a row: a running row shows its run's own status (needs you, paused); the others their row status. */
export function itemChipStatus(item: Pick<BatchItem, 'status' | 'runStatus'>): string {
  if (item.status === 'running' && item.runStatus) return item.runStatus;
  return item.status === 'skipped' ? 'not started' : item.status === 'pending' ? 'waiting' : item.status;
}

/** The chip of a batch. */
export function batchChipStatus(status: BatchStatus | string): string {
  return status === 'review' ? 'waiting for review' : status;
}

/** A row's values as one line: "Recipient: Ana · Message: Dinner moved to 7". */
export function valuesLine(item: Pick<BatchItem, 'values'>): string {
  return item.values.map((v) => `${v.label}: ${v.value}`).join(' · ') || 'No values';
}

/** Why a batch stopped early, in words; null when it did not. */
export function stopReasonWords(batch: Pick<Batch, 'stopReason' | 'stoppedAtSeq'>): string | null {
  switch (batch.stopReason) {
    case 'owner_stopped':
      return 'Stopped by you.';
    case 'unknown_outcome':
      return batch.stoppedAtSeq ? `Row ${batch.stoppedAtSeq} ended with a step that may or may not have happened, so the batch stopped. Check it before you run the rest.` : 'A row ended with a step that may or may not have happened, so the batch stopped.';
    case 'row_failed':
      return batch.stoppedAtSeq ? `Row ${batch.stoppedAtSeq} failed, so the batch stopped.` : 'A row failed, so the batch stopped.';
    case 'task_deleted':
      return 'The task was deleted, so the batch stopped.';
    default:
      return null;
  }
}

/** The parameters that cannot run in a batch (a value asked for securely). */
export function sensitiveParameters(params: readonly TaskParameter[] | null | undefined): TaskParameter[] {
  return (params ?? []).filter((p) => p.sensitive);
}

/** Why a task cannot run for several rows, or null when it can. */
export function batchUnavailableReason(params: readonly TaskParameter[] | null | undefined): string | null {
  const list = params ?? [];
  if (list.length === 0) return 'This task has no values that change between runs. Add a {{Name}} to its goal first.';
  const sensitive = sensitiveParameters(list);
  if (sensitive.length) return `${sensitive.map((p) => p.label).join(', ')} is asked for securely, so this task cannot run for several rows.`;
  return null;
}

// ---- Paste rows from a spreadsheet ----

/** Tab-separated text as rows of cells. A cell in double quotes may hold tabs, new lines and `""` (as a spreadsheet copies it). */
export function splitTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const src = text.replace(/\r\n?/g, '\n');
  while (i < src.length) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        quoted = false;
        i += 1;
        continue;
      }
      cell += c;
      i += 1;
      continue;
    }
    if (c === '"' && cell === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (c === '\t') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
    i += 1;
  }
  row.push(cell);
  rows.push(row);
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export interface PastedRows {
  /** One object per row, by parameter key; a blank cell is left out. */
  rows: Record<string, string>[];
  /** The first line was a header of labels (or keys). */
  header: boolean;
  /** Something the owner should know: a column that matched no parameter, extra cells. */
  warnings: string[];
}

/**
 * Rows pasted from a spreadsheet. When every non-blank cell of the first line names a parameter (its label or key, any case),
 * that line is the header and says which column is which; otherwise the columns are the parameters in order.
 */
export function parsePastedRows(text: string, params: readonly Pick<TaskParameter, 'key' | 'label'>[]): PastedRows {
  const lines = splitTsv(text);
  const warnings: string[] = [];
  if (lines.length === 0 || params.length === 0) return { rows: [], header: false, warnings };
  const byName = new Map<string, string>();
  for (const p of params) {
    byName.set(norm(p.label), p.key);
    byName.set(norm(p.key), p.key);
  }
  const first = lines[0]!;
  const named = first.filter((c) => c.trim() !== '');
  const header = named.length > 0 && named.every((c) => byName.has(norm(c)));
  let columns: (string | null)[];
  let body: string[][];
  if (header) {
    columns = first.map((c) => (c.trim() ? (byName.get(norm(c)) ?? null) : null));
    body = lines.slice(1);
  } else {
    columns = params.map((p) => p.key);
    body = lines;
  }
  let extra = false;
  const rows = body.map((cells) => {
    const out: Record<string, string> = {};
    cells.forEach((raw, i) => {
      const key = columns[i];
      const value = raw.trim();
      if (!key) {
        if (value) extra = true;
        return;
      }
      if (value && !(key in out)) out[key] = value;
    });
    return out;
  });
  if (extra) warnings.push(header ? 'Some columns did not match a value of this task and were left out.' : `Only the first ${params.length} column${params.length === 1 ? '' : 's'} were used: ${params.map((p) => p.label).join(', ')}.`);
  return { rows, header, warnings };
}

// ---- The API's errors on the form ----

export interface RowErrors {
  /** A message for the whole row. */
  row?: string;
  /** A message per cell, by parameter key. */
  cells: Record<string, string>;
}

export interface BatchFormErrors {
  /** The words above the table. */
  message: string;
  /** By the row's 1-based position in the request. */
  rows: Record<number, RowErrors>;
}

const ROW_CODES = new Set(['INVALID_INPUT', 'BATCH_INPUTS_MISSING', 'BATCH_DUPLICATE_ROW']);

/**
 * A failed `POST /tasks/{id}/batches` as the form shows it: `details.rows` of INVALID_INPUT (`issues` by key),
 * BATCH_INPUTS_MISSING (`missing` labels) and BATCH_DUPLICATE_ROW (`rows: [a, b]`) are put on their rows and cells; any
 * other error is its message alone.
 */
export function batchFormErrors(error: unknown, params: readonly Pick<TaskParameter, 'key' | 'label'>[]): BatchFormErrors {
  if (!isPlatformApiError(error)) return { message: error instanceof Error && error.message ? error.message : 'Could not start the runs', rows: {} };
  const message = error.message || 'Could not start the runs';
  const details = (error.details && typeof error.details === 'object' ? error.details : {}) as { rows?: unknown };
  if (!error.code || !ROW_CODES.has(error.code) || !Array.isArray(details.rows)) return { message, rows: {} };
  const keyOf = (name: unknown): string | null => {
    if (typeof name !== 'string') return null;
    const n = norm(name);
    return params.find((p) => norm(p.key) === n || norm(p.label) === n)?.key ?? null;
  };
  const rows: Record<number, RowErrors> = {};
  const at = (row: number) => (rows[row] ??= { cells: {} });
  for (const raw of details.rows as unknown[]) {
    const r = (raw ?? {}) as { row?: unknown; message?: unknown; issues?: unknown; missing?: unknown; rows?: unknown };
    if (typeof r.row !== 'number' || !Number.isInteger(r.row) || r.row < 1) continue;
    const e = at(r.row);
    if (error.code === 'BATCH_INPUTS_MISSING' && Array.isArray(r.missing)) {
      const labels = r.missing.filter((m): m is string => typeof m === 'string');
      for (const label of labels) {
        const key = keyOf(label);
        if (key) e.cells[key] = 'Enter a value';
      }
      e.row = `Needs ${labels.join(', ') || 'a value'}`;
    } else if (error.code === 'BATCH_DUPLICATE_ROW' && Array.isArray(r.rows)) {
      const other = (r.rows as unknown[]).find((n) => typeof n === 'number' && n !== r.row);
      e.row = typeof other === 'number' ? `Same values as row ${other}` : 'Same values as another row';
    } else {
      const issues = Array.isArray(r.issues) ? (r.issues as { key?: unknown; message?: unknown }[]) : [];
      const loose: string[] = [];
      for (const i of issues) {
        const words = typeof i?.message === 'string' ? i.message : 'Check this value';
        const key = keyOf(i?.key);
        if (key) e.cells[key] ??= words;
        else loose.push(typeof i?.key === 'string' ? `${i.key}: ${words}` : words);
      }
      if (loose.length) e.row = loose.join('; ');
      else if (!issues.length) e.row = typeof r.message === 'string' ? r.message : 'Check this row';
    }
  }
  return { message, rows };
}
