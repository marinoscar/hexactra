// Task parameters in the console (E36.7, #556): what the task form, the run
// dialog, the `form` card and the schedule editor share. The placeholder
// syntax and the value rules are the shared ones (`@app/shared/task-params`,
// #552); this file never parses a goal itself. Pure, except the per-browser
// suggestions, which wrap every storage access in try/catch.
import { isPlatformApiError } from '@marinoscar/platform-web/core';
import { displayValue, normalizeValue, parseGoal, render, type GoalError, type GoalSegment, type TaskParameter, type TaskParameterType } from '@app/shared/task-params';
import { maskText } from '@app/shared/sensitive-patterns';

export type { GoalError, GoalSegment, TaskParameter, TaskParameterType } from '@app/shared/task-params';
export { MAX_PARAMETERS, parseGoal, paramKey } from '@app/shared/task-params';

/** The types in the order the form lists them, with their words. */
export const TYPE_LABEL: Record<TaskParameterType, string> = {
  text: 'Text',
  number: 'Number',
  money: 'Amount of money',
  date: 'Date',
  choice: 'Choice',
  phone: 'Phone',
  email: 'Email',
};
export const TYPE_ORDER: readonly TaskParameterType[] = ['text', 'number', 'money', 'date', 'choice', 'phone', 'email'];

/** How a parameter gets its value when the task runs. */
export type DefaultMode = 'ask' | 'value' | 'memory' | 'identity';

/** The saved identity fields a parameter may take its value from (E37.6), with the words a person reads. */
export const IDENTITY_FIELD_LABEL: Record<string, string> = {
  full_name: 'Full name',
  date_of_birth: 'Date of birth',
  id_type: 'ID type',
  id_number: 'ID number',
  id_issuing_country: 'ID issuing country',
  address_line1: 'Address line 1',
  address_line2: 'Address line 2',
  city: 'City',
  region: 'Region',
  postal_code: 'Postal code',
  country: 'Country',
  phone: 'Phone',
  email: 'Email',
};

export function defaultMode(p: Pick<TaskParameter, 'default' | 'sensitive'>): DefaultMode {
  if (p.sensitive || !p.default) return 'ask';
  if ('identity' in p.default) return 'identity';
  return 'memory' in p.default ? 'memory' : 'value';
}

/** A new parameter for a placeholder: text, required, labelled with its name. */
export function newParameter(key: string, name: string): TaskParameter {
  return { key, label: name, type: 'text', required: true };
}

/**
 * The parameters a goal has, kept in step with what the form holds: one per
 * placeholder, in order of first appearance; a known key keeps its definition,
 * a new one gets {@link newParameter}. `removed` lists the definitions whose
 * placeholder left the goal (the form offers to undo).
 */
export function syncParameters(goal: string, current: readonly TaskParameter[]): { parameters: TaskParameter[]; removed: TaskParameter[]; errors: GoalError[] } {
  const { params, errors } = parseGoal(goal);
  const byKey = new Map(current.map((p) => [p.key, p]));
  const parameters = params.map((p) => byKey.get(p.key) ?? newParameter(p.key, p.name));
  const keys = new Set(params.map((p) => p.key));
  return { parameters, removed: current.filter((p) => !keys.has(p.key)), errors };
}

/** Whether the run must ask for this value: required, and no saved value (a sensitive one is always asked). */
export function isMissing(p: TaskParameter): boolean {
  return p.sensitive === true || (p.required !== false && !p.default);
}

/** The values a run of the task asks for before it starts. */
export function missingParameters(params: readonly TaskParameter[] | null | undefined): TaskParameter[] {
  return (params ?? []).filter(isMissing);
}

/** The parameters with a saved value (fixed or from a memory), which the run dialog lists under "Using saved values". */
export function savedParameters(params: readonly TaskParameter[] | null | undefined): TaskParameter[] {
  return (params ?? []).filter((p) => !p.sensitive && p.default !== undefined);
}

/** The words of a saved value: the fixed value masked, or the memory it comes from. */
export function savedValueText(p: TaskParameter, memoryLabel?: (id: string) => string | undefined): string {
  if (!p.default) return 'Asked every time';
  if ('value' in p.default) return maskValue(displayValue(p, p.default.value));
  if ('identity' in p.default) return `From your saved details: ${IDENTITY_FIELD_LABEL[p.default.identity.field] ?? p.default.identity.field}`;
  const name = memoryLabel?.(p.default.memory.id);
  return name ? `From a memory: ${name} → ${p.default.memory.attribute}` : `From a memory (${p.default.memory.attribute})`;
}

/** A value masked the way run views show it (#538): a phone or an account number keeps its last digits. */
export function maskValue(value: string): string {
  return maskText(value).text;
}

/**
 * The goal with sample or saved values filled in, masked, for the preview
 * line under the goal: a fixed default is shown, everything else reads as
 * `[Label]`.
 */
export function previewGoal(goal: string, params: readonly TaskParameter[], values: Record<string, string> = {}): string {
  const byKey = new Map(params.map((p) => [p.key, p]));
  const filled: Record<string, string> = {};
  for (const p of params) {
    const v = values[p.key] ?? (p.default && 'value' in p.default ? p.default.value : undefined);
    if (v !== undefined && v !== '' && !p.sensitive) filled[p.key] = v;
  }
  return render(goal, filled, {
    display: (key, value) => maskValue(displayValue(byKey.get(key) ?? null, value)),
    missing: (ph) => `[${byKey.get(ph.key)?.label ?? ph.name}]`,
  });
}

/** The error to show under a field, or null. An empty optional field is fine; an empty required one says so. */
export function valueError(p: Pick<TaskParameter, 'type' | 'options' | 'constraints' | 'required'>, value: string, opts: { timeZone?: string | null } = {}): string | null {
  if (!value.trim()) return p.required === false ? null : 'Enter a value';
  const r = normalizeValue(p, value, opts);
  return r.error ?? null;
}

/** Every field's error, by key; empty when the values can be sent. */
export function valuesErrors(params: readonly TaskParameter[], values: Record<string, string>, opts: { timeZone?: string | null } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of params) {
    const e = valueError(p, values[p.key] ?? '', opts);
    if (e) out[p.key] = e;
  }
  return out;
}

/** Only the values that were typed: what `inputs` or `fields` carries. */
export function filledValues(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, v.trim()]));
}

/** The keyboard a phone shows for a type. */
export function inputModeOf(type: TaskParameterType): 'decimal' | 'numeric' | 'tel' | 'email' | 'text' {
  if (type === 'money') return 'decimal';
  if (type === 'number') return 'decimal';
  if (type === 'phone') return 'tel';
  if (type === 'email') return 'email';
  return 'text';
}

/**
 * A 400 about parameter values or definitions, by key: `INVALID_INPUT`,
 * `INVALID_PARAMETERS` and `SCHEDULE_INPUTS_MISSING` carry `details.issues`
 * with a `key` (or a path ending in it). Null when the error names no key.
 */
export function issuesByKey(error: unknown): Record<string, string> | null {
  if (!isPlatformApiError(error)) return null;
  const details = (error.details && typeof error.details === 'object' ? error.details : {}) as { issues?: { key?: unknown; path?: unknown; message?: unknown }[] };
  if (!Array.isArray(details.issues)) return null;
  const out: Record<string, string> = {};
  for (const i of details.issues) {
    const key = typeof i?.key === 'string' ? i.key : typeof i?.path === 'string' ? (/\.([^.[\]]+)$/.exec(i.path)?.[1] ?? null) : null;
    if (key && !(key in out)) out[key] = typeof i?.message === 'string' ? i.message : 'Check this value';
  }
  return Object.keys(out).length ? out : null;
}

// ---- Suggestions: the last values used for a task, in this browser only ----

const SUGGEST_PREFIX = 'hexactra.taskInputs.';
const SUGGEST_MAX = 5;

/** The last values typed for a task, newest first, per key. Never a sensitive one. */
export function loadSuggestions(taskId: string): Record<string, string[]> {
  try {
    const raw = window.localStorage.getItem(SUGGEST_PREFIX + taskId);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string').slice(0, SUGGEST_MAX);
    return out;
  } catch {
    return {};
  }
}

/** Keeps the values just used for a task (never a sensitive parameter's). */
export function saveSuggestions(taskId: string, params: readonly TaskParameter[], values: Record<string, string>): void {
  try {
    const now = loadSuggestions(taskId);
    for (const p of params) {
      if (p.sensitive) {
        delete now[p.key];
        continue;
      }
      const v = values[p.key]?.trim();
      if (!v) continue;
      now[p.key] = [v, ...(now[p.key] ?? []).filter((x) => x !== v)].slice(0, SUGGEST_MAX);
    }
    window.localStorage.setItem(SUGGEST_PREFIX + taskId, JSON.stringify(now));
  } catch {
    // Storage off or full: suggestions are a convenience.
  }
}

/**
 * Definitions as the form saves them, in the server's field order (so an
 * unchanged task is not dirty): an empty saved value, an unpicked memory, an
 * empty help line and empty limits are left out, options only for a choice,
 * and a sensitive parameter never has a saved value.
 */
export function cleanParameters(params: readonly TaskParameter[]): TaskParameter[] {
  return params.map((p) => {
    const out: TaskParameter = { key: p.key, label: p.label.trim() || p.key, type: p.type, required: p.required !== false };
    if (p.type === 'choice') out.options = (p.options ?? []).map((o) => o.trim()).filter(Boolean);
    const help = p.help?.trim();
    if (help) out.help = help;
    if (!p.sensitive && p.default) {
      if ('value' in p.default && p.default.value.trim()) out.default = { value: p.default.value.trim() };
      else if ('identity' in p.default && p.default.identity.field) out.default = { identity: { field: p.default.identity.field } };
      else if ('memory' in p.default && p.default.memory.id && p.default.memory.attribute) out.default = { memory: { id: p.default.memory.id, attribute: p.default.memory.attribute } };
    }
    const c = p.constraints ?? {};
    const constraints: NonNullable<TaskParameter['constraints']> = {};
    if (typeof c.min === 'number') constraints.min = c.min;
    if (typeof c.max === 'number') constraints.max = c.max;
    if (typeof c.maxLength === 'number') constraints.maxLength = c.maxLength;
    if (typeof c.pattern === 'string' && c.pattern) constraints.pattern = c.pattern;
    if (Object.keys(constraints).length) out.constraints = constraints;
    if (p.sensitive) out.sensitive = true;
    return out;
  });
}
