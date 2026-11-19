// What a delivery may say about a finished run (E39.6, #603): the run's facts, read once, masked like every other view (#538), and
// nothing else. A delivery is deterministic: it formats THESE facts into a message, a payload, a row or a file name. The model is not
// in this step, and nothing a page said can change which facts there are or where they go.
//
// Masking: the result and the text of an output go through `maskSensitive`; a `sensitive` output reads `[hidden]` (MASKED_OUTPUT)
// unless the owner configured this delivery to carry it (`includeSensitive`): only then its stored value is used, and only by that
// delivery. The raw value of a sensitive output lives in `FactOutput.rawText`, in memory, for the length of the job.
import { MASKED_OUTPUT, formatOutputValue, type OutputValue } from '@app/shared/task-fields';

import { readConfirmedActions } from '../runner/confirmed-actions';
import { maskSensitive } from '../tasks/mask';
import { TERMINAL_RUN_STATUSES } from '../tasks/run-status';
import { maskedOutputValue } from '../tasks/task-outputs';
import { readOutputs, readStoredOutputs, type TaskOutput } from '../tasks/task-outputs.schemas';
import type { DeliveryWhen } from './deliveries.constants';
import type { TemplateValues } from './delivery.templates';

export interface FactOutput {
  key: string;
  label: string;
  type: TaskOutput['type'];
  required: boolean;
  sensitive: boolean;
  /** The value as a view shows it: a sensitive one is `[hidden]`, text is masked. */
  masked: OutputValue;
  /** `masked` as text. */
  text: string;
  /** Only for a sensitive output that has a value: what the run returned. Used only by a delivery with `includeSensitive`. */
  rawText?: string;
  /** The stored value of a sensitive output that has one, typed (a webhook carries it as it is stored). Same rule as `rawText`. */
  rawValue?: OutputValue;
  /** A number or a yes/no stays typed in a spreadsheet cell. */
  maskedCell: string | number | boolean | null;
  rawCell?: string | number | boolean | null;
  ok: boolean;
  note: string | null;
}

export interface RunFacts {
  runId: string;
  userId: string;
  taskId: string | null;
  taskName: string;
  goal: string;
  trigger: string;
  status: string;
  /** Masked. */
  result: string | null;
  /** Masked. */
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  costUsd: number;
  costKnown: boolean;
  stepCount: number;
  confirmedActions: number;
  outputs: FactOutput[] | null;
  outputsComplete: boolean | null;
  /** The schedule that started the run, if one did. */
  scheduleId: string | null;
}

export interface RunRow {
  id: string;
  userId: string;
  taskId: string | null;
  goal: string;
  trigger: string;
  status: string;
  result: string | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  costUsd: unknown;
  costKnown: boolean;
  stepCount: number;
  confirmedActions: unknown;
  outputs: unknown;
  outputsSpec: unknown;
  outputsComplete: boolean | null;
  task?: { name: string } | null;
}

const cell = (v: OutputValue | undefined): string | number | boolean | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v;
  return formatOutputValue(null, v);
};

/** The facts of a run row. Pure: the caller reads the row (as its owner) and passes it. */
export function factsOf(run: RunRow, scheduleId: string | null = null): RunFacts {
  const spec = readOutputs(run.outputsSpec);
  const stored = readStoredOutputs(run.outputs);
  const finished = (TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status);
  const outputs: FactOutput[] | null = spec.length
    ? spec.map((def) => {
        const s = stored[def.key];
        const masked = maskedOutputValue(def, s?.value);
        const hasValue = s !== undefined && s.value !== null && s.value !== undefined;
        return {
          key: def.key,
          label: def.label,
          type: def.type,
          required: def.required !== false,
          sensitive: def.sensitive === true,
          masked,
          text: masked === null ? '' : formatOutputValue(def, masked),
          ...(def.sensitive && hasValue ? { rawText: formatOutputValue(def, s!.value), rawValue: s!.value } : {}),
          maskedCell: cell(masked),
          ...(def.sensitive && hasValue ? { rawCell: cell(s!.value) } : {}),
          ok: s ? s.ok === true : false,
          note: s?.note ? maskSensitive(String(s.note)).text : s || !finished ? null : 'Not found',
        };
      })
    : null;
  return {
    runId: run.id,
    userId: run.userId,
    taskId: run.taskId,
    taskName: run.task?.name ?? '',
    goal: maskSensitive(run.goal).text,
    trigger: run.trigger,
    status: run.status,
    result: run.result ? maskSensitive(run.result).text : null,
    error: run.error ? maskSensitive(run.error).text : null,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    costUsd: Number(run.costUsd ?? 0),
    costKnown: run.costKnown,
    stepCount: run.stepCount,
    confirmedActions: readConfirmedActions(run.confirmedActions).length,
    outputs,
    outputsComplete: run.outputsComplete,
    scheduleId,
  };
}

/** `needs_attention`: a failed run, a run whose outputs are not all there, a run that ended without success after a confirmed step (#540). */
export function needsAttention(f: Pick<RunFacts, 'status' | 'outputsComplete' | 'confirmedActions'>): boolean {
  return f.status === 'failed' || f.outputsComplete === false || (f.confirmedActions > 0 && f.status !== 'succeeded');
}

/** Whether a delivery with this `when` is sent for a run like this. */
export function whenMatches(when: DeliveryWhen, f: Pick<RunFacts, 'status' | 'outputsComplete' | 'confirmedActions'>): boolean {
  switch (when) {
    case 'always':
      return true;
    case 'succeeded':
      return f.status === 'succeeded';
    case 'failed':
      return f.status === 'failed';
    case 'needs_attention':
      return needsAttention(f);
  }
}

/** The status as a word a person reads in a subject: "succeeded", "failed", "stopped". */
export function statusWord(status: string): string {
  return status === 'cancelled' ? 'stopped' : status;
}

/** The outcome in one sentence. */
export function outcomeSentence(f: RunFacts): string {
  if (f.status === 'succeeded') return f.outputsComplete === false ? 'The run finished, but not every output was found.' : 'The run succeeded.';
  if (f.status === 'cancelled') return 'The run was stopped before it finished.';
  return 'The run failed.';
}

/** The "what to check" line of a run that ended without success after a confirmed step carried out, else null (#540). */
export function whatToCheck(f: Pick<RunFacts, 'status' | 'confirmedActions'>): string | null {
  if (f.status === 'succeeded' || f.confirmedActions === 0) return null;
  return 'A step you confirmed was carried out before the run ended. Check the account to see whether it went through before you run this again.';
}

/** `2026-11-18`: the day the run ended (UTC), as `{{date}}` and the run-date column say it. */
export function runDay(f: Pick<RunFacts, 'finishedAt' | 'createdAt'>): string {
  return (f.finishedAt ?? f.createdAt).toISOString().slice(0, 10);
}

/** What a template may use: always the masked text, even in a delivery that carries sensitive values (a subject and a file name are seen by more people). */
export function templateValuesOf(f: RunFacts): TemplateValues {
  const by = new Map((f.outputs ?? []).map((o) => [o.key, o]));
  return {
    task: f.taskName || 'Run',
    date: runDay(f),
    status: statusWord(f.status),
    output: (key) => {
      const o = by.get(key);
      return o ? (o.sensitive ? MASKED_OUTPUT : o.text) : undefined;
    },
  };
}
