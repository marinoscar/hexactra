// `hexactra runs show` and `hexactra tasks outputs` (E39.5, #600): what a run returned, as lines and as a table or a CSV a
// spreadsheet takes. The values arrive masked from the API (a sensitive output reads `[hidden]`); nothing is unmasked here.
import { formatOutputValue, type OutputValue, type TaskOutputType } from '@app/shared/task-fields';

/** One output of a run as `GET /runs/{id}` returns it. */
export interface CliRunOutput {
  key: string;
  label: string;
  type: TaskOutputType;
  required: boolean;
  sensitive: boolean;
  value: OutputValue;
  ok: boolean;
  note: string | null;
}

/** What `GET /tasks/{id}/outputs` returns. */
export interface CliOutputsPage {
  columns: { key: string; label: string; type: TaskOutputType; sensitive?: boolean }[];
  items: { runId: string; status: string; createdAt: string; finishedAt: string | null; outputsComplete: boolean | null; values: Record<string, CliRunOutput> }[];
  nextCursor: string | null;
}

/** A value as a person reads it: `Not found` (with the agent's reason) for a missing one. */
export function outputText(o: Pick<CliRunOutput, 'type' | 'value' | 'ok' | 'note'>): string {
  if (o.value === null) return o.ok ? '' : `not found${o.note && o.note !== 'Not found' ? ` (${o.note.toLowerCase()})` : ''}`;
  return typeof o.value === 'string' && o.value === '[hidden]' ? o.value : formatOutputValue(o, o.value);
}

/** The lines of `runs show` for a run's outputs: empty for a run without any. */
export function outputLines(outputs: readonly CliRunOutput[] | null | undefined, complete: boolean | null | undefined): string[] {
  if (!outputs?.length) return [];
  return ['outputs:', ...outputs.map((o) => `  ${o.label}: ${outputText(o) || '-'}`), ...(complete === false ? ['  (not every output was found)'] : [])];
}

/** One CSV field: quoted when it holds a comma, a quote or a line break; a leading `=`, `+`, `-` or `@` is prefixed so a spreadsheet reads text, not a formula. */
export function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) && !/^-?\d+(\.\d+)?$/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The history as a CSV: the run, when it finished, its status, then one column per output label. Money is the amount alone, its currency its own column. */
export function outputsCsv(page: Pick<CliOutputsPage, 'columns' | 'items'>): string {
  const money = new Set(page.columns.filter((c) => c.type === 'money').map((c) => c.key));
  const head = ['run', 'finished', 'status', ...page.columns.flatMap((c) => (money.has(c.key) ? [c.label, `${c.label} (currency)`] : [c.label]))];
  const rows = page.items.map((i) => [
    i.runId,
    i.finishedAt ?? '',
    i.status,
    ...page.columns.flatMap((c) => {
      const v = i.values[c.key];
      if (money.has(c.key)) {
        const m = v?.value && typeof v.value === 'object' ? v.value : null;
        return [m ? String(m.amount) : v?.value === '[hidden]' ? '[hidden]' : '', m?.currency ?? ''];
      }
      return [v ? outputText(v) : ''];
    }),
  ]);
  return `${[head, ...rows].map((r) => r.map(csvField).join(',')).join('\n')}\n`;
}

/** The history as aligned text, one line per run. */
export function outputsTable(page: Pick<CliOutputsPage, 'columns' | 'items'>): string[] {
  const head = ['run', 'status', ...page.columns.map((c) => c.label)];
  const rows = page.items.map((i) => [i.runId.slice(0, 8), i.status, ...page.columns.map((c) => (i.values[c.key] ? outputText(i.values[c.key]!) || '-' : '-'))]);
  const widths = head.map((h, n) => Math.min(40, Math.max(h.length, ...rows.map((r) => r[n]!.length))));
  const line = (cells: string[]) => cells.map((c, n) => (c.length > widths[n]! ? `${c.slice(0, widths[n]! - 1)}…` : c).padEnd(widths[n]!)).join('  ').trimEnd();
  return [line(head), ...rows.map(line)];
}
