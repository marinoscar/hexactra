// Task outputs in the console (E39.5, #600): what the task form, the run page, the chat result card and the task's history
// share. The definitions, the key rule and the value words are the shared ones (`@app/shared/task-fields`); the
// types are the API's (`apps/api/src/openapi/console.responses.ts`). Pure.
import { MASKED_OUTPUT, MAX_OUTPUTS, OUTPUT_TYPES, formatOutputValue, outputKey, type OutputValue, type TaskOutput, type TaskOutputType } from '@app/shared/task-fields';

export type { OutputValue, TaskOutput, TaskOutputType } from '@app/shared/task-fields';
export { MASKED_OUTPUT, MAX_OUTPUTS, outputKey } from '@app/shared/task-fields';

/** The types in the order the form lists them, with their words. */
export const OUTPUT_TYPE_LABEL: Record<TaskOutputType, string> = {
  text: 'Text',
  number: 'Number',
  money: 'Amount of money',
  date: 'Date',
  datetime: 'Date and time',
  boolean: 'Yes or no',
  url: 'Web address',
  choice: 'Choice',
};
export const OUTPUT_TYPE_ORDER: readonly TaskOutputType[] = OUTPUT_TYPES;

/** One output of a run as `GET /runs/{id}` returns it: the definition as the run started with it, and the value (masked). */
export interface RunOutput {
  key: string;
  label: string;
  type: TaskOutputType;
  required: boolean;
  sensitive: boolean;
  value: OutputValue;
  ok: boolean;
  note: string | null;
}

/** `GET /tasks/{id}/outputs`. */
export interface TaskOutputsPage {
  columns: TaskOutput[];
  items: { runId: string; status: string; createdAt: string; finishedAt: string | null; outputsComplete: boolean | null; values: Record<string, RunOutput> }[];
  nextCursor: string | null;
}

/** A new output row of the form: text, required. The key is derived from the label until the owner edits it. */
export function newOutput(label = ''): TaskOutput {
  return { key: '', label, type: 'text', required: true };
}

/** The key a row saves under: the one the owner typed, else the one the label gives (a taken one gets `_2`, `_3`, as the server does). */
export function effectiveKeys(outputs: readonly TaskOutput[]): string[] {
  const taken = new Set(outputs.filter((o) => o.key).map((o) => o.key));
  return outputs.map((o) => {
    if (o.key) return o.key;
    const base = outputKey(o.label) || 'output';
    let key = base;
    for (let n = 2; taken.has(key); n += 1) key = `${base.slice(0, 40 - String(n).length - 1)}_${n}`;
    taken.add(key);
    return key;
  });
}

/** The outputs the form saves: rows with a label, keys filled in, empty help and options left out. */
export function cleanOutputs(outputs: readonly TaskOutput[]): TaskOutput[] {
  const rows = outputs.filter((o) => o.label.trim() !== '');
  const keys = effectiveKeys(rows);
  return rows.map((o, i) => {
    const out: TaskOutput = { key: keys[i]!, label: o.label.trim(), type: o.type, required: o.required !== false };
    if (o.type === 'choice' && o.options?.length) out.options = o.options;
    if (o.help?.trim()) out.help = o.help.trim();
    if (o.sensitive) out.sensitive = true;
    return out;
  });
}

/** Problems the server would refuse, found before Save: by row index. */
export function outputProblems(outputs: readonly TaskOutput[]): Record<number, string> {
  const out: Record<number, string> = {};
  const keys = effectiveKeys(outputs);
  const seen = new Map<string, number>();
  outputs.forEach((o, i) => {
    const typed = o.key.trim();
    if (o.label.trim() === '' && (typed !== '' || o.help?.trim() || o.type !== 'text')) out[i] = 'Give the output a label';
    else if (o.label.trim() === '') return;
    else if (typed !== '' && !/^[a-z0-9][a-z0-9_]*$/.test(typed)) out[i] = 'The key is lower-case letters, digits and _';
    else if (typed.length > 40) out[i] = 'The key is at most 40 characters';
    else if (o.type === 'choice' && !((o.options?.length ?? 0) >= 2 && (o.options?.length ?? 0) <= 50)) out[i] = 'A choice needs 2 to 50 options';
    if (o.label.trim() !== '') {
      const key = keys[i]!;
      if (seen.has(key) && typed !== '' && !out[i]) out[i] = 'Another output has this key';
      seen.set(key, i);
    }
  });
  const filled = outputs.filter((o) => o.label.trim() !== '').length;
  if (filled > MAX_OUTPUTS) out[-1] = `At most ${MAX_OUTPUTS} outputs`;
  return out;
}

/** The value as a person reads it, with words for a missing one. */
export function outputValueText(o: Pick<RunOutput, 'type' | 'value' | 'ok' | 'note'>): string {
  if (o.value === null) return o.ok ? '—' : 'Not found';
  if (o.value === MASKED_OUTPUT) return MASKED_OUTPUT;
  return formatOutputValue(o, o.value);
}

/** Whether a run's outputs are worth a block: some defined. */
export function hasOutputs(outputs: readonly RunOutput[] | null | undefined): outputs is readonly RunOutput[] {
  return Array.isArray(outputs) && outputs.length > 0;
}

/** How many of a run's outputs were not found (required ones with no valid value). */
export function missingCount(outputs: readonly RunOutput[]): number {
  return outputs.filter((o) => !o.ok).length;
}
