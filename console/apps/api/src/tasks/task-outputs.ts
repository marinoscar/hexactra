// Task outputs at work (E39.5, #600): checking a task's definitions, joining a run's stored values with the definitions it
// started with, and masking them for every view. Pure apart from the exceptions it throws. The value rules are `@app/shared/task-fields`.
import { BadRequestException } from '@nestjs/common';
import { MASKED_OUTPUT, MAX_OUTPUT_KEY_LENGTH, outputDefinitionProblems, outputKey, type OutputValue, type TaskOutput } from '@app/shared/task-fields';

import { registerErrorCode } from '@marinoscar/platform-api/core';

import { maskSensitive } from './mask';
import { readOutputs, readStoredOutputs, type OutputView } from './task-outputs.schemas';

registerErrorCode({ code: 'INVALID_OUTPUTS', status: 400, description: "A task output's definition is invalid (`details.issues` per key): a duplicate key, an unknown type, a choice without 2 to 50 options." });

/** The shape a caller may send: a key is optional. */
export type TaskOutputInput = Omit<TaskOutput, 'key' | 'required'> & { key?: string; required?: boolean };

/**
 * The outputs a task stores for `defs`: a key derived from the label where none is given (a derived key that is already
 * taken gets `_2`, `_3`), a clean definition per output, checked. 400 `INVALID_OUTPUTS` lists the problems per key.
 */
export function prepareOutputs(defs: readonly TaskOutputInput[] | null | undefined): TaskOutput[] {
  const list = defs ?? [];
  const taken = new Set(list.filter((d) => d.key).map((d) => d.key as string));
  const clean = list.map((d) => {
    let key = d.key;
    if (!key) {
      const base = outputKey(d.label) || 'output';
      key = base;
      for (let n = 2; taken.has(key); n += 1) key = `${base.slice(0, MAX_OUTPUT_KEY_LENGTH - String(n).length - 1)}_${n}`;
      taken.add(key);
    }
    const out: TaskOutput = { key, label: d.label, type: d.type, required: d.required !== false };
    if (d.options?.length) out.options = d.options;
    if (d.help) out.help = d.help;
    if (d.sensitive) out.sensitive = true;
    return out;
  });
  const issues = outputDefinitionProblems(clean);
  if (issues.length) throw new BadRequestException({ code: 'INVALID_OUTPUTS', message: issues.map((i) => (i.key ? `${i.key}: ${i.message}` : i.message)).join('; '), details: { issues } });
  return clean;
}

/** A value as a view shows it: a sensitive one hidden, any text masked like the rest of the trace (#538). */
export function maskedOutputValue(def: Pick<TaskOutput, 'sensitive'>, value: OutputValue | undefined): OutputValue {
  if (value === null || value === undefined) return null;
  if (def.sensitive) return MASKED_OUTPUT;
  if (typeof value === 'string') return maskSensitive(value).text;
  return value;
}

/**
 * A run's outputs for a view or an export: one entry per definition the run STARTED with (`runs.outputs_spec`, never the
 * task's current ones, so an edit never relabels an old run), with the stored value, masked. Null for a run without outputs.
 * A sensitive value is hidden whole; a note never holds a value (the reasons are written without one). `finished`: whether the run has ended.
 */
export function outputsView(specRaw: unknown, storedRaw: unknown, finished = true): OutputView[] | null {
  const spec = readOutputs(specRaw);
  if (spec.length === 0) return null;
  const stored = readStoredOutputs(storedRaw);
  return spec.map((def) => {
    const s = stored[def.key];
    return {
      key: def.key,
      label: def.label,
      type: def.type,
      required: def.required !== false,
      sensitive: def.sensitive === true,
      value: maskedOutputValue(def, s?.value),
      ok: s ? s.ok === true : false,
      // No stored value on a finished run is "not found"; on a live run it is just not there yet.
      note: s?.note ? maskSensitive(String(s.note)).text : s || !finished ? null : 'Not found',
    };
  });
}

/** The definitions a run starts with: the task's, or null for none. */
export function outputsSpecOf(raw: unknown): TaskOutput[] | null {
  const spec = readOutputs(raw);
  return spec.length ? spec : null;
}
