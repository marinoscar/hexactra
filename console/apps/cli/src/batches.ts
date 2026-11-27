// `hexactra tasks run <task> --rows <file>` and `hexactra batches …` (E51.1, #1006): a saved task run once per row of values.
// Pure helpers: the rows file (a JSON array of objects, or a CSV with a header of parameter keys or labels) and the lines a batch
// prints. The API checks every row (and names a bad one) before anything is written.
import { matchInputKey } from '@app/shared/task-params';

import type { CliTaskParameter } from './task-inputs.js';

/** A batch as `GET /api/batches/{id}` returns it (the fields the CLI reads). */
export interface CliBatch {
  id: string;
  taskName: string | null;
  status: 'review' | 'running' | 'done' | 'cancelled';
  total: number;
  stopReason: string | null;
  stoppedAtSeq: number | null;
  summary: string;
  items: { seq: number; status: string; runId: string | null; values: { key: string; label: string; value: string }[]; result: string | null }[];
}

/** One CSV line into fields: commas, double quotes around a field, `""` for a quote inside one. */
export function csvFields(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

/**
 * The rows of a rows file: a JSON array of objects (`[{ "Recipient": "Ana", "Message": "…" }]`), or a CSV whose header names the
 * task's parameters by key or label. A header that is no parameter of the task is an error, as an empty file is; empty cells are
 * left out (a default may fill them).
 */
export function parseRowsFile(text: string, params: readonly CliTaskParameter[]): Record<string, string>[] {
  const trimmed = text.replace(/^﻿/, '').trim();
  if (!trimmed) throw new Error('The rows file is empty');
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || parsed.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) throw new Error('A JSON rows file is an array of objects, one per run');
    return (parsed as Record<string, unknown>[]).map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '').map(([k, v]) => [k, String(v)])));
  }
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = csvFields(lines[0]!);
  const unknown = header.filter((h) => !matchInputKey(params, h));
  if (unknown.length) throw new Error(`Not a parameter of this task: ${unknown.join(', ')}. Its parameters: ${params.map((p) => p.label).join(', ')}`);
  return lines.slice(1).map((line) => {
    const cells = csvFields(line);
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      const v = cells[i];
      if (v !== undefined && v !== '') row[h] = v;
    });
    return row;
  });
}

/** The rows as the confirmation prompt lists them: `1. Recipient: Ana · Message: …`. */
export function rowLines(rows: readonly Record<string, string>[]): string[] {
  return rows.map((r, i) => `${i + 1}. ${Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(' · ')}`);
}

const STATUS_WORD: Record<string, string> = { pending: 'not started', running: 'running', succeeded: 'done', failed: 'failed', cancelled: 'stopped', skipped: 'skipped' };

/** A batch as `batches show` prints it: one line for the batch, one per row. */
export function batchLines(b: CliBatch): string[] {
  const why =
    b.stopReason === 'owner_stopped' ? ' (stopped by you)' : b.stopReason === 'unknown_outcome' ? ` (row ${b.stoppedAtSeq} ended with a step that may or may not have happened)` : b.stopReason === 'row_failed' ? ` (row ${b.stoppedAtSeq} failed)` : '';
  return [
    `batch ${b.id}${b.taskName ? ` of "${b.taskName}"` : ''}: ${b.status}, ${b.summary}${why}`,
    ...b.items.map((i) => `  ${i.seq}. ${STATUS_WORD[i.status] ?? i.status}${i.runId ? `  run ${i.runId}` : ''}  ${i.values.map((v) => `${v.label}: ${v.value}`).join(' · ')}${i.result ? `\n     ${i.result.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`),
  ];
}

/** Whether the batch has ended (a follower stops). */
export const batchEnded = (b: Pick<CliBatch, 'status'>): boolean => b.status === 'done' || b.status === 'cancelled';
