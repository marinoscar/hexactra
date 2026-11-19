// The task form's values (#427): what the form edits, how a task becomes
// values, how values become the request bodies of `POST /tasks`,
// `PATCH /tasks/:id` and `PUT /tasks/:id/schedules`, and how an API error is
// mapped back to a field. Pure; the form component owns the requests.
//
// The form never sends `maxSteps`, `maxMinutes` or `model` (deprecated by
// agent policies, #401): they are not part of these shapes.
import { isPlatformApiError } from '@marinoscar/platform-web/core';

import { draftFromSchedule, draftToItem, newScheduleDraft, type ScheduleDraft, type ScheduleItemInput } from '../schedule/draft';
import { cleanParameters, syncParameters, type TaskParameter } from '../taskParams/model';
import type { Task } from '../types/tasks';

export const NAME_MAX = 200;
/** The name's counter shows from this length. */
export const NAME_COUNTER_FROM = 150;
export const GOAL_MAX = 4000;
export const MAX_ALLOWED_DOMAINS = 50;
export const MAX_SCHEDULES = 10;
export const DEFAULT_PROFILE = 'default';

/** The server's `profileNameSchema` (apps/api/src/fleet/fleet.schemas.ts), mirrored exactly. */
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const PROFILE_NAME_MESSAGE = 'Use 1-32 lowercase letters, digits, - and _';

/** The server's `domain` schema (apps/api/src/tasks/tasks.schemas.ts), mirrored exactly (after trim and lower-casing). */
export const DOMAIN_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** A new schedule of this form: Monday to Friday at 09:00. */
export const NEW_SCHEDULE_CRON = '0 9 * * 1-5';

export interface TaskFormValues {
  name: string;
  goal: string;
  profile: string;
  hostId: string | null;
  hostFallback: boolean;
  /** `null` follows the user's default policy. */
  policyId: string | null;
  allowedDomains: string[];
  confirmRiskyActions: boolean;
  /**
   * The definitions of the goal's `{{Name}}` parameters (#556). It may hold
   * definitions whose placeholder left the goal (so an undo restores them);
   * what is saved is this list kept in step with the goal.
   */
  parameters: TaskParameter[];
  /** Each carries an optional `policyId` override. */
  schedules: ScheduleDraft[];
}

/** The task fields of the form: everything but the schedules. */
export type TaskFieldValues = Omit<TaskFormValues, 'schedules'>;

/** A task as `GET /tasks/:id?include=summary` returns it: the form reads its schedules. */
export interface TaskWithSchedules extends Task {
  summary?: {
    schedules: { id: string; cron: string; timezone: string; enabled: boolean; concurrency?: 'skip' | 'queue'; policyId?: string | null; description?: string; nextRunAt?: string | null; consecutiveFailures?: number; inputs?: Record<string, string> | null }[];
  };
}

export function emptyValues(): TaskFormValues {
  return { name: '', goal: '', profile: DEFAULT_PROFILE, hostId: null, hostFallback: true, policyId: null, allowedDomains: [], confirmRiskyActions: false, parameters: [], schedules: [] };
}

/** The form values of a saved task. */
export function valuesFromTask(task: TaskWithSchedules): TaskFormValues {
  return {
    name: task.name,
    goal: task.goal,
    profile: task.profile,
    hostId: task.hostId ?? null,
    hostFallback: task.hostFallback,
    policyId: task.policyId ?? null,
    allowedDomains: [...task.allowedDomains],
    confirmRiskyActions: task.confirmRiskyActions,
    parameters: (task.parameters ?? []).map((p) => ({ ...p })),
    schedules: (task.summary?.schedules ?? []).map(draftFromSchedule),
  };
}

/** A copy of a task (`/tasks/new?from=<id>`): "Copy of ...", same policy, its schedules as new ones, paused. */
export function copyValues(task: TaskWithSchedules): TaskFormValues {
  const values = valuesFromTask(task);
  return {
    ...values,
    name: `Copy of ${task.name}`.slice(0, NAME_MAX),
    schedules: values.schedules.map(({ id: _id, ...draft }) => ({ ...draft, enabled: false })),
  };
}

/** A schedule added in this form: weekdays at 09:00 in the profile time zone, active, on the task's policy. */
export function newFormSchedule(profileTimezone: string): ScheduleDraft {
  return { ...newScheduleDraft(profileTimezone), cron: NEW_SCHEDULE_CRON };
}

// ---- Allowed sites ----

/**
 * One typed or pasted entry as a site: trimmed, lower-cased, and a URL
 * reduced to its hostname (`https://shop.example.test/cart` is
 * `shop.example.test`). Returns `''` for nothing.
 */
export function normalizeDomain(entry: string): string {
  let text = entry.trim().toLowerCase();
  if (!text) return '';
  const wildcard = text.startsWith('*.');
  if (wildcard) text = text.slice(2);
  // A scheme, a path, a port, a query: keep the host.
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  text = text.replace(/^[^@/]*@/, '');
  text = text.split(/[/?#]/)[0] ?? '';
  text = text.replace(/:\d+$/, '').replace(/\.$/, '');
  if (!text) return '';
  return wildcard ? `*.${text}` : text;
}

export function isValidDomain(domain: string): boolean {
  return DOMAIN_RE.test(domain);
}

/** Text with several entries (typed with commas or spaces, or pasted) as its entries. */
export function splitDomains(text: string): string[] {
  return text.split(/[\s,;]+/).filter(Boolean);
}

/** `current` plus `entries`, normalised, without duplicates, at most 50. */
export function addDomains(current: readonly string[], entries: readonly string[]): string[] {
  const next = [...current];
  for (const entry of entries) {
    const domain = normalizeDomain(entry);
    if (!domain || next.includes(domain) || next.length >= MAX_ALLOWED_DOMAINS) continue;
    next.push(domain);
  }
  return next;
}

// ---- Validation ----

/** A field's place in the form: a task field, `allowedDomains[2]`, or `schedules[1]` / `schedules[1].cron`. */
export type FieldErrors = Record<string, string>;

/** What blocks Save before any request: the same rules as the server's schemas. */
export function validateValues(values: TaskFormValues, options: { checkProfile: boolean }): FieldErrors {
  const errors: FieldErrors = {};
  if (!values.name.trim()) errors.name = 'Give the task a name';
  else if (values.name.trim().length > NAME_MAX) errors.name = `At most ${NAME_MAX} characters`;
  if (!values.goal.trim()) errors.goal = 'Say what the agent should do';
  else if (values.goal.trim().length > GOAL_MAX) errors.goal = `At most ${GOAL_MAX} characters`;
  if (options.checkProfile && !PROFILE_NAME_RE.test(values.profile)) errors.profile = PROFILE_NAME_MESSAGE;
  const invalid = values.allowedDomains.filter((d) => !isValidDomain(d));
  if (invalid.length > 0) errors.allowedDomains = `${invalid.map((d) => `“${d}”`).join(', ')} ${invalid.length === 1 ? 'is not a site' : 'are not sites'}. Use a hostname such as example.test or *.example.test.`;
  else if (values.allowedDomains.length > MAX_ALLOWED_DOMAINS) errors.allowedDomains = `At most ${MAX_ALLOWED_DOMAINS} sites`;
  return errors;
}

// ---- Request bodies ----

/** `POST /tasks`. */
export interface CreateTaskBody {
  name: string;
  goal: string;
  profile: string;
  hostId: string | null;
  hostFallback: boolean;
  allowedDomains: string[];
  confirmRiskyActions: boolean;
  /** Present only when the viewer may pick a policy (`agent_policies:read`) and the policies loaded. */
  policyId?: string | null;
  /** The goal's parameters (#556): present only when the goal has a placeholder. */
  parameters?: TaskParameter[];
  /** Present only when the form has schedules. */
  schedules?: ScheduleItemInput[];
}

/** The parameters the form saves: one per placeholder of the goal, cleaned. */
export function savedParameters(values: Pick<TaskFieldValues, 'goal' | 'parameters'>): TaskParameter[] {
  return cleanParameters(syncParameters(values.goal.trim(), values.parameters).parameters);
}

function fieldBody(values: TaskFieldValues): Omit<CreateTaskBody, 'policyId' | 'schedules' | 'parameters'> & { parameters: TaskParameter[] } {
  return {
    name: values.name.trim(),
    goal: values.goal.trim(),
    profile: values.profile.trim() || DEFAULT_PROFILE,
    hostId: values.hostId || null,
    hostFallback: values.hostFallback,
    allowedDomains: [...values.allowedDomains],
    confirmRiskyActions: values.confirmRiskyActions,
    parameters: savedParameters(values),
  };
}

export function scheduleItems(schedules: readonly ScheduleDraft[]): ScheduleItemInput[] {
  return schedules.map(draftToItem);
}

/** The body of `POST /tasks`: the task and its schedules in one request. */
export function createBody(values: TaskFormValues, options: { sendPolicy: boolean }): CreateTaskBody {
  const { parameters, ...fields } = fieldBody(values);
  return {
    ...fields,
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(options.sendPolicy ? { policyId: values.policyId } : {}),
    ...(values.schedules.length > 0 ? { schedules: scheduleItems(values.schedules) } : {}),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The body of `PATCH /tasks/:id`: only the task fields that differ from `initial`; `null` when none does. */
export function patchBody(values: TaskFieldValues, initial: TaskFieldValues, options: { sendPolicy: boolean }): Partial<CreateTaskBody> | null {
  const now = fieldBody(values);
  const before = fieldBody(initial);
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(now) as (keyof typeof now)[]) {
    if (!same(now[key], before[key])) patch[key] = now[key];
  }
  if (options.sendPolicy && values.policyId !== initial.policyId) patch.policyId = values.policyId;
  return Object.keys(patch).length > 0 ? (patch as Partial<CreateTaskBody>) : null;
}

/** Whether the schedule set differs from `initial` (then the form sends `PUT /tasks/:id/schedules`). */
export function schedulesChanged(schedules: readonly ScheduleDraft[], initial: readonly ScheduleDraft[]): boolean {
  return !same(scheduleItems(schedules), scheduleItems(initial));
}

export function isDirty(values: TaskFormValues, initial: TaskFormValues): boolean {
  const { schedules, ...fields } = values;
  const { schedules: initialSchedules, ...initialFields } = initial;
  return !same({ ...fieldBody(fields), policyId: fields.policyId }, { ...fieldBody(initialFields), policyId: initialFields.policyId }) || schedulesChanged(schedules, initialSchedules);
}

// ---- API errors ----

export interface MappedError {
  /** Messages by field path (`name`, `policyId`, `allowedDomains`, `schedules[1]`, `schedules`). */
  fields: FieldErrors;
  /** What no field explains; null when every issue found its field. */
  banner: string | null;
}

const TASK_FIELDS = ['name', 'goal', 'profile', 'hostId', 'hostFallback', 'policyId', 'allowedDomains', 'confirmRiskyActions', 'parameters'];

/** `allowedDomains.2` (zod) and `schedules[1].cron` (the schedule checks) in one spelling: `a[2]`, `schedules[1].cron`. */
export function normalizePath(path: unknown): string {
  const text = Array.isArray(path) ? path.join('.') : String(path ?? '');
  return text.replace(/\.(\d+)(?=\.|$)/g, '[$1]');
}

/** The field a server path belongs to, or null: `allowedDomains[2]` is `allowedDomains`, `schedules[1].cron` is `schedules[1]`. */
export function fieldOfPath(path: string): string | null {
  const schedule = /^schedules\[(\d+)\]/.exec(path);
  if (schedule) return `schedules[${schedule[1]}]`;
  if (path === 'schedules') return 'schedules';
  // A parameter's definition (`parameters[2].default`) is that parameter's row only when the key is known: the caller maps it.
  const head = path.split(/[.[]/)[0] ?? '';
  return TASK_FIELDS.includes(head) ? head : null;
}

/** Drops the path the API puts in front of a schedule message (`schedules[1].cron: ...`). */
function withoutPath(message: string, path: string): string {
  return message.startsWith(`${path}: `) ? message.slice(path.length + 2) : message;
}

/**
 * An API failure as field messages. A 400's `details.path` and
 * `details.issues[].path` name the field; `POLICY_REF_INVALID` without a path
 * is the policy select; a 409 `SCHEDULE_LIMIT` is the Schedule section.
 * Whatever has no field goes to the banner.
 */
export function mapApiError(error: unknown, fallback: string): MappedError {
  const message = error instanceof Error && error.message ? error.message : isPlatformApiError(error) && error.message ? error.message : fallback;
  if (!isPlatformApiError(error)) return { fields: {}, banner: message };
  const details = (error.details && typeof error.details === 'object' ? error.details : {}) as { path?: unknown; issues?: { path?: unknown; message?: unknown }[] };
  const issues: { path: string; message: string }[] = [];
  const fields: FieldErrors = {};
  if (Array.isArray(details.issues)) {
    for (const issue of details.issues as { path?: unknown; key?: unknown; message?: unknown }[]) {
      // A parameter's problem (#552) names its key: it goes on that parameter's row.
      if (typeof issue?.key === 'string' && issue.path === undefined) {
        const field = `param:${issue.key}`;
        if (!(field in fields)) fields[field] = typeof issue.message === 'string' ? issue.message : message;
        continue;
      }
      issues.push({ path: normalizePath(issue?.path), message: typeof issue?.message === 'string' ? issue.message : message });
    }
  }
  if (error.code === 'INVALID_GOAL') return { fields: { goal: message }, banner: null };
  if (issues.length === 0 && Object.keys(fields).length === 0 && details.path !== undefined) issues.push({ path: normalizePath(details.path), message });

  const unplaced: string[] = [];
  for (const issue of issues) {
    const field = fieldOfPath(issue.path);
    const text = withoutPath(issue.message, issue.path);
    if (!field) unplaced.push(issue.path ? `${issue.path}: ${text}` : text);
    else if (!(field in fields)) fields[field] = field === 'allowedDomains' && /\[\d+\]/.test(issue.path) ? `Site ${Number(/\[(\d+)\]/.exec(issue.path)![1]) + 1}: ${text}` : text;
  }
  if (issues.length === 0 && Object.keys(fields).length > 0) return { fields, banner: null };
  if (issues.length === 0) {
    if (error.code === 'POLICY_REF_INVALID') fields.policyId = 'This policy is not available. Choose another.';
    else if (error.code === 'SCHEDULE_LIMIT' || error.code === 'SCHEDULE_NOT_IN_TASK') fields.schedules = message;
    else return { fields, banner: message };
  }
  return { fields, banner: unplaced.length > 0 ? unplaced.join(' ') : null };
}
