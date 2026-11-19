// What a webhook delivery sends and what a spreadsheet delivery writes (E39.6, #603): pure functions of the run's facts and the
// delivery's fixed configuration. Values are data: they fill a field or a cell, as the type they have, and do nothing else.
import { MASKED_OUTPUT } from '@app/shared/task-fields';

import { runDay, type FactOutput, type RunFacts } from './delivery-facts';
import type { ColumnSource, RunField, SheetRowConfig, WebhookConfig } from './delivery.schemas';

const GOAL_MAX = 300;
const RESULT_MAX = 2000;
const CELL_MAX = 5000;

export interface WebhookLinks {
  runUrl: string;
  /** Only when the delivery asked for it. */
  reportUrl: string | null;
}

/** The `data` of the webhook: the `runs.run.finished` fields, with the outputs the delivery was set up to carry. */
export function webhookData(facts: RunFacts, cfg: Pick<WebhookConfig, 'includeOutputs' | 'includeSensitive' | 'includeReportLink'>, links: WebhookLinks, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: facts.runId,
    taskId: facts.taskId,
    goal: facts.goal.slice(0, GOAL_MAX),
    trigger: facts.trigger,
    status: facts.status,
    result: facts.result ? facts.result.slice(0, RESULT_MAX) : null,
    error: facts.error,
    ...(cfg.includeOutputs && facts.outputs
      ? {
          outputs: facts.outputs.map((o) => ({
            key: o.key,
            label: o.label,
            type: o.type,
            required: o.required,
            sensitive: o.sensitive,
            value: cfg.includeSensitive && o.rawValue !== undefined ? o.rawValue : o.masked,
            ok: o.ok,
            note: o.note,
          })),
          outputsComplete: facts.outputsComplete,
        }
      : {}),
    runUrl: links.runUrl,
    ...(cfg.includeReportLink && links.reportUrl ? { reportUrl: links.reportUrl } : {}),
    ...extra,
  };
}

/** The header the delivery writes for each fixed field; an output column uses the owner's own header text. */
export const RUN_ID_HEADER = 'Run ID';

export interface SheetLinks {
  runUrl: string;
  reportUrl: string | null;
}

type Cell = string | number | boolean | null;

const text = (s: string | null | undefined): string => (s && s.length > CELL_MAX ? `${s.slice(0, CELL_MAX - 1)}…` : (s ?? ''));

function fieldCell(field: RunField, facts: RunFacts, links: SheetLinks): Cell {
  switch (field) {
    case 'run_date':
      return runDay(facts);
    case 'status':
      return facts.status;
    case 'task':
      return text(facts.taskName);
    case 'goal':
      return text(facts.goal);
    case 'result':
      return text(facts.result);
    case 'run_link':
      return links.runUrl;
    case 'report_link':
      return links.reportUrl ?? '';
    case 'cost':
      return facts.costKnown ? Math.round(facts.costUsd * 1e6) / 1e6 : null;
    case 'steps':
      return facts.stepCount;
  }
}

function outputCell(o: FactOutput | undefined, includeSensitive: boolean): Cell {
  if (!o) return '';
  if (o.sensitive && !(includeSensitive && o.rawCell !== undefined)) return MASKED_OUTPUT;
  const v = includeSensitive && o.rawCell !== undefined ? o.rawCell : o.maskedCell;
  return typeof v === 'string' ? text(v) : v;
}

/** One cell by column source. A string stays a string, a number a number: a spreadsheet adapter writes it raw (a leading `=` is text). */
export function sourceCell(source: ColumnSource, facts: RunFacts, links: SheetLinks, includeSensitive: boolean): Cell {
  if (source.kind === 'field') return fieldCell(source.field, facts, links);
  return outputCell(facts.outputs?.find((o) => o.key === source.key), includeSensitive);
}

/** The header row: the owner's headers, then "Run ID". */
export function sheetHeaders(cfg: Pick<SheetRowConfig, 'columns'>): string[] {
  return [...cfg.columns.map((c) => c.header), RUN_ID_HEADER];
}

/** The row: one cell per configured column, then the run's id (the last column: how a retry finds its own row). */
export function sheetRow(facts: RunFacts, cfg: Pick<SheetRowConfig, 'columns' | 'includeSensitive'>, links: SheetLinks): Cell[] {
  return [...cfg.columns.map((c) => sourceCell(c.value, facts, links, cfg.includeSensitive)), facts.runId];
}

/** `A`..`Z`, `AA`..: the column letters of 1-based index `n`. */
export function columnLetter(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}
