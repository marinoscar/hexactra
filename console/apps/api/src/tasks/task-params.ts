// Task parameters at work (E36.6, #552): checking a task's definitions against
// its goal, resolving a run's values (given, preset, default, memory) and
// rendering the goal the model reads. Pure, apart from the memory resolver a
// caller passes. The syntax and value rules are `@app/shared/task-params`.
import { BadRequestException } from '@nestjs/common';
import {
  MARK_CLOSE,
  MARK_OPEN,
  definitionProblems,
  displayValue,
  matchInputKey,
  normalizeValue,
  reconcileParameters,
  render,
  type TaskParameter,
} from '@app/shared/task-params';

import { registerErrorCode } from '@marinoscar/platform-api/core';

import { maskSensitive } from './mask';
import type { InputSource, RunInputs } from './task-params.schemas';

// The task parameter error codes (registered once, at import: the exception
// filter passes a payload `code` through only when it is registered).
registerErrorCode({ code: 'INVALID_GOAL', status: 400, description: "A `{{Name}}` placeholder of the task's goal is malformed (`details.positions`)." });
registerErrorCode({ code: 'INVALID_PARAMETERS', status: 400, description: "A task parameter's definition is invalid (`details.issues` per key)." });
registerErrorCode({ code: 'UNKNOWN_INPUT', status: 400, description: 'An input names no parameter of the task (or the task has none).' });
registerErrorCode({ code: 'INVALID_INPUT', status: 400, description: "A value does not meet its parameter's rules (`details.issues` per key)." });
registerErrorCode({ code: 'SENSITIVE_INPUT', status: 400, description: 'A sensitive parameter is never passed in: it is asked for in the signed-in console when the run starts.' });
registerErrorCode({ code: 'SCHEDULE_INPUTS_MISSING', status: 400, description: 'An enabled schedule has no value (preset, default or memory) for a required parameter of its task.' });

/** An issue with one parameter's value or definition: `details.issues` of a 400. */
export interface ParamIssue {
  key: string;
  message: string;
}

/**
 * The parameters a task stores for `goal`: one per placeholder, inferred
 * where none is given, checked. 400 `INVALID_GOAL` names the position of a
 * malformed placeholder; 400 `INVALID_PARAMETERS` lists the problems per key.
 */
export function prepareParameters(goal: string, defs: readonly Partial<TaskParameter>[] | null | undefined): TaskParameter[] {
  const { parameters, errors } = reconcileParameters(goal, defs ?? []);
  if (errors.length) {
    throw new BadRequestException({ code: 'INVALID_GOAL', message: errors.map((e) => e.message).join('; '), details: { positions: errors.map((e) => e.position) } });
  }
  const clean = parameters.map((p) => {
    const out: TaskParameter = { key: p.key, label: p.label, type: p.type, required: p.required !== false };
    if (p.type === 'choice' && p.options) out.options = p.options;
    else if (p.options?.length) out.options = p.options;
    if (p.help) out.help = p.help;
    if (p.default) out.default = p.default;
    if (p.constraints && Object.keys(p.constraints).length) out.constraints = p.constraints;
    if (p.sensitive) out.sensitive = true;
    return out;
  });
  const issues = clean.flatMap((p) => definitionProblems(p));
  if (issues.length) throw new BadRequestException({ code: 'INVALID_PARAMETERS', message: issues.map((i) => `${i.key}: ${i.message}`).join('; '), details: { issues } });
  return clean;
}

/** Resolves a memory-backed default to the memory's attribute value, or null when it cannot (then the value is asked for). */
export interface MemoryValueResolver {
  resolve(userId: string, ref: { id: string; attribute: string }): Promise<string | null>;
}
/** The DI token of the memory resolver; without one, a memory-backed default is always missing. */
export const MEMORY_VALUE_RESOLVER = Symbol('MEMORY_VALUE_RESOLVER');

/**
 * `inputs` as the caller gave them, keyed by parameter key. 400 `UNKNOWN_INPUT`
 * for a name that is no parameter (or any input on a task without parameters),
 * 400 `SENSITIVE_INPUT` for a sensitive parameter (never accepted from a caller).
 */
export function keyInputs(params: readonly TaskParameter[], inputs: Record<string, string | number> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = Object.entries(inputs ?? {});
  if (entries.length && params.length === 0) throw new BadRequestException({ code: 'UNKNOWN_INPUT', message: 'This task has no parameters: send no inputs' });
  const unknown = entries.filter(([name]) => !matchInputKey(params, name)).map(([n]) => n);
  if (unknown.length) {
    throw new BadRequestException({ code: 'UNKNOWN_INPUT', message: `Not a parameter of this task: ${unknown.join(', ')}. Its parameters: ${params.map((p) => p.key).join(', ')}`, details: { unknown } });
  }
  for (const [name, v] of entries) {
    const key = matchInputKey(params, name)!;
    if (params.find((p) => p.key === key)?.sensitive) {
      throw new BadRequestException({ code: 'SENSITIVE_INPUT', message: `${key} is sensitive: it is asked for in the signed-in console when the run starts, never passed in` });
    }
    out[key] = String(v);
  }
  return out;
}

/** Every value checked against its parameter; 400 `INVALID_INPUT` with `details.issues` per key. */
export function checkValues(params: readonly TaskParameter[], values: Record<string, string>, opts: { timeZone?: string | null; now?: Date } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const issues: ParamIssue[] = [];
  for (const [key, raw] of Object.entries(values)) {
    const def = params.find((p) => p.key === key);
    if (!def) continue;
    const r = normalizeValue(def, raw, opts);
    if (r.error !== undefined) issues.push({ key, message: r.error });
    else out[key] = r.value;
  }
  if (issues.length) throw new BadRequestException({ code: 'INVALID_INPUT', message: issues.map((i) => `${i.key}: ${i.message}`).join('; '), details: { issues } });
  return out;
}

export interface ResolvedInputs {
  /** Every value known, with where it came from. */
  values: RunInputs['values'];
  /** Required parameters with no value: asked for in one form before the run starts. */
  missing: TaskParameter[];
  /** Sensitive parameters: asked for as a secret once the browser is open. */
  sensitive: { key: string; label: string }[];
}

/**
 * A run's values: those `given` (already keyed and checked), then a schedule's
 * `presets`, then each parameter's default (fixed, or a memory through
 * `resolver`). A preset or default that no longer passes the checks is
 * treated as missing. An optional parameter without a value stays empty.
 */
export async function resolveInputs(
  userId: string,
  params: readonly TaskParameter[],
  given: Record<string, string>,
  opts: { presets?: Record<string, string> | null; presetSource?: InputSource; resolver?: MemoryValueResolver | null; timeZone?: string | null; now?: Date } = {},
): Promise<ResolvedInputs> {
  const values: RunInputs['values'] = {};
  const missing: TaskParameter[] = [];
  const sensitive: ResolvedInputs['sensitive'] = [];
  const check = (def: TaskParameter, raw: string): string | null => {
    const r = normalizeValue(def, raw, { timeZone: opts.timeZone, now: opts.now });
    return r.error === undefined ? r.value : null;
  };
  for (const p of params) {
    if (p.sensitive) {
      sensitive.push({ key: p.key, label: p.label });
      continue;
    }
    let got: { value: string; source: InputSource } | null = null;
    if (given[p.key] !== undefined) got = { value: given[p.key]!, source: 'provided' };
    const preset = opts.presets?.[p.key];
    if (!got && preset !== undefined && preset !== null && String(preset).trim() !== '') {
      const v = check(p, String(preset));
      if (v !== null) got = { value: v, source: opts.presetSource ?? 'schedule' };
    }
    if (!got && p.default && 'value' in p.default) {
      const v = check(p, p.default.value);
      if (v !== null) got = { value: v, source: 'default' };
    }
    if (!got && p.default && 'memory' in p.default && opts.resolver) {
      const raw = await opts.resolver.resolve(userId, p.default.memory).catch(() => null);
      const v = raw === null ? null : check(p, raw);
      if (v !== null) got = { value: v, source: 'memory' };
    }
    if (got) values[p.key] = { ...got, label: p.label };
    else if (p.required) missing.push(p);
  }
  return { values, missing, sensitive };
}

/**
 * The goal the run stores and the model reads: each value between the data
 * markers ⟦ ⟧ (a date in words), a sensitive parameter as `[provided: <label>]`,
 * an optional parameter without a value as an empty string. One pass: a value
 * is text, never read again as a placeholder.
 */
export function renderRunGoal(goal: string, params: readonly TaskParameter[], values: RunInputs['values']): string {
  const plain: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) plain[k] = v.value;
  const byKey = new Map(params.map((p) => [p.key, p]));
  return render(goal, plain, {
    mark: true,
    display: (key, value) => displayValue(byKey.get(key), value),
    missing: ({ key, name }) => {
      const p = byKey.get(key);
      return p?.sensitive ? `[provided: ${p.label}]` : p ? '' : `{{${name}}}`;
    },
  }).slice(0, 4000);
}

/** The goal as a person reads it in the console: each inserted value masked (#538); the model still reads the real one. */
export function maskRunGoal(goal: string): string {
  if (!goal.includes(MARK_OPEN)) return goal;
  return goal.replace(new RegExp(`${MARK_OPEN}([^${MARK_OPEN}${MARK_CLOSE}]*)${MARK_CLOSE}`, 'gu'), (_m, v: string) => `${MARK_OPEN}${maskSensitive(v).text}${MARK_CLOSE}`);
}

/** `runs.inputs` as the API returns it: values masked, with their source. Never a sensitive value (none is stored). */
export function runInputsView(raw: unknown): { key: string; label: string; value: string; source: InputSource }[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<RunInputs>;
  const values = r.values && typeof r.values === 'object' ? r.values : {};
  const out = Object.entries(values).map(([key, v]) => ({ key, label: v.label ?? key, value: maskSensitive(String(v.value ?? '')).text, source: v.source }));
  for (const s of Array.isArray(r.sensitive) ? r.sensitive : []) out.push({ key: s.key, label: s.label, value: '[provided at run time]', source: 'asked' });
  return out;
}

/** The fields of the `form` question that asks for `missing` (#552). */
export function formFields(missing: readonly TaskParameter[]) {
  return missing.map((p) => ({
    key: p.key,
    label: p.label,
    type: p.type,
    required: p.required,
    ...(p.options ? { options: p.options } : {}),
    ...(p.help ? { help: p.help } : {}),
    ...(p.constraints ? { constraints: p.constraints } : {}),
  }));
}
export type FormField = ReturnType<typeof formFields>[number];

/**
 * A schedule's preset values (#552), keyed and checked like a run's inputs (a
 * sensitive parameter is refused). Stored as given, so `today` stays a word and
 * is resolved at each firing.
 */
export function scheduleInputs(params: readonly TaskParameter[], raw: Record<string, string | number> | null | undefined): Record<string, string> {
  const keyed = keyInputs(params, raw);
  checkValues(params, keyed);
  return keyed;
}

/** The required parameters a schedule's runs would have no value for: no preset, no default, not from a memory. Sensitive ones are asked at run time and never block a schedule. */
export function missingForSchedule(params: readonly TaskParameter[], presets: Record<string, string> | null | undefined): TaskParameter[] {
  return params.filter((p) => p.required && !p.sensitive && !p.default && !(presets && presets[p.key] !== undefined && String(presets[p.key]).trim() !== ''));
}

/** 400 `SCHEDULE_INPUTS_MISSING` naming the values an enabled schedule would lack. */
export function assertScheduleInputs(params: readonly TaskParameter[], presets: Record<string, string> | null | undefined, path = 'inputs'): void {
  const missing = missingForSchedule(params, presets);
  if (!missing.length) return;
  const issues = missing.map((p) => ({ key: p.key, path: `${path}.${p.key}`, message: `${p.label} needs a value for this schedule (or a default on the task)` }));
  throw new BadRequestException({ code: 'SCHEDULE_INPUTS_MISSING', message: `This schedule has no value for: ${missing.map((p) => p.label).join(', ')}`, details: { issues } });
}
