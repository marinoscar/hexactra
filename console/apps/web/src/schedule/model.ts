// The schedule builder's model: what the editor's modes hold, and the 5-field
// cron expression each one stands for. Pure code, no React. The stored value
// is always the cron expression; the server (apps/api/src/schedules/cron.ts)
// stays the judge of what is valid, and says the expression in words.

export type TimeOfDay = { hour: number; minute: number };
/** 0 = Sunday, as cron. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type MinuteStep = (typeof MINUTE_STEPS)[number];
export type HourStep = (typeof HOUR_STEPS)[number];

export type ScheduleSpec =
  | { mode: 'minutes'; every: MinuteStep }
  | { mode: 'hours'; every: HourStep; minute: number }
  | { mode: 'daily'; times: TimeOfDay[] }
  | { mode: 'weekly'; days: Weekday[]; time: TimeOfDay }
  | { mode: 'monthly'; days: number[]; time: TimeOfDay }
  | { mode: 'advanced'; cron: string };

export type ScheduleMode = ScheduleSpec['mode'];

/** The server refuses anything under 5 minutes (`CRON_TOO_FREQUENT`). */
export const MINUTE_STEPS = [5, 10, 15, 20, 30] as const;
export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;
export const MAX_DAILY_TIMES = 4;
export const MAX_MONTHLY_DAYS = 5;

export const SCHEDULE_MODES: ReadonlyArray<{ mode: ScheduleMode; label: string }> = [
  { mode: 'minutes', label: 'Minutes' },
  { mode: 'hours', label: 'Hourly' },
  { mode: 'daily', label: 'Daily' },
  { mode: 'weekly', label: 'Weekly' },
  { mode: 'monthly', label: 'Monthly' },
  { mode: 'advanced', label: 'Advanced' },
];

/** Monday first, as the editor shows them. */
export const WEEKDAYS: ReadonlyArray<{ day: Weekday; name: string; short: string; letter: string }> = [
  { day: 1, name: 'Monday', short: 'Mon', letter: 'M' },
  { day: 2, name: 'Tuesday', short: 'Tue', letter: 'T' },
  { day: 3, name: 'Wednesday', short: 'Wed', letter: 'W' },
  { day: 4, name: 'Thursday', short: 'Thu', letter: 'T' },
  { day: 5, name: 'Friday', short: 'Fri', letter: 'F' },
  { day: 6, name: 'Saturday', short: 'Sat', letter: 'S' },
  { day: 0, name: 'Sunday', short: 'Sun', letter: 'S' },
];

export const WEEKDAY_PRESETS: ReadonlyArray<{ label: string; days: Weekday[] }> = [
  { label: 'Weekdays', days: [1, 2, 3, 4, 5] },
  { label: 'Weekends', days: [0, 6] },
  { label: 'Every day', days: [0, 1, 2, 3, 4, 5, 6] },
];

/** The five fields of a cron expression, in order. */
export const CRON_FIELDS = ['minute', 'hour', 'day of month', 'month', 'day of week'] as const;

/** What a new schedule starts as: every day at 09:00. */
export const DEFAULT_CRON = '0 9 * * *';

const isInt = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;
const validTime = (t: TimeOfDay) => isInt(t.hour, 0, 23) && isInt(t.minute, 0, 59);
const ascending = (a: number, b: number) => a - b;
const unique = (values: number[]) => [...new Set(values)].sort(ascending);

/** `[1,2,3,4,5]` → `1-5`; anything that is not one unbroken run → `1,3,5`. */
function listField(values: number[]): string {
  const sorted = unique(values);
  const run = sorted.length > 1 && sorted.every((v, i) => i === 0 || v === sorted[i - 1]! + 1);
  return run ? `${sorted[0]}-${sorted[sorted.length - 1]}` : sorted.join(',');
}

/**
 * The cron expression of a spec. Call it on a spec `validateSpec` accepts: an
 * invalid one (no day chosen, times at different minutes) has no expression
 * and what comes back is not meaningful.
 */
export function specToCron(spec: ScheduleSpec): string {
  switch (spec.mode) {
    case 'minutes':
      return `*/${spec.every} * * * *`;
    case 'hours':
      return `${spec.minute} ${spec.every === 1 ? '*' : `*/${spec.every}`} * * *`;
    case 'daily':
      return `${spec.times[0]?.minute ?? 0} ${unique(spec.times.map((t) => t.hour)).join(',')} * * *`;
    case 'weekly':
      return `${spec.time.minute} ${spec.time.hour} * * ${listField(spec.days)}`;
    case 'monthly':
      return `${spec.time.minute} ${spec.time.hour} ${unique(spec.days).join(',')} * *`;
    case 'advanced':
      return spec.cron.trim().replace(/\s+/g, ' ');
  }
}

const INT = /^\d+$/;

/** A plain number field within a range, or null. */
function intField(field: string, min: number, max: number): number | null {
  if (!INT.test(field)) return null;
  const n = Number(field);
  return n >= min && n <= max ? n : null;
}

/** `1-3,5` → `[1,2,3,5]`: numbers and ranges only (no `*`, steps or names), or null. */
function listValues(field: string, min: number, max: number): number[] | null {
  const out: number[] = [];
  for (const part of field.split(',')) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from > to || from < min || to > max) return null;
      for (let v = from; v <= to; v++) out.push(v);
    } else {
      const v = intField(part, min, max);
      if (v === null) return null;
      out.push(v);
    }
  }
  return out;
}

/**
 * The spec of a cron expression: the builder mode that produces it, or
 * Advanced with the text unchanged when no mode does. Never throws. Equivalent
 * spellings are read (`1,2,3,4,5` as `1-5`, `7` as Sunday, `*​/1` hours as
 * every hour); names (`MON-FRI`) and steps the builder does not offer stay in
 * Advanced.
 */
export function cronToSpec(cron: string): ScheduleSpec {
  const advanced: ScheduleSpec = { mode: 'advanced', cron };
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return advanced;
  const [min, hour, dom, month, dow] = fields as [string, string, string, string, string];
  if (month !== '*') return advanced;

  if (dom === '*' && dow === '*') {
    const everyMinutes = /^\*\/(\d+)$/.exec(min);
    if (everyMinutes) {
      const every = Number(everyMinutes[1]);
      return hour === '*' && (MINUTE_STEPS as readonly number[]).includes(every) ? { mode: 'minutes', every: every as MinuteStep } : advanced;
    }
    const minute = intField(min, 0, 59);
    if (minute === null) return advanced;
    if (hour === '*') return { mode: 'hours', every: 1, minute };
    const everyHours = /^\*\/(\d+)$/.exec(hour);
    if (everyHours) {
      const every = Number(everyHours[1]);
      return (HOUR_STEPS as readonly number[]).includes(every) ? { mode: 'hours', every: every as HourStep, minute } : advanced;
    }
    const hours = listValues(hour, 0, 23);
    if (!hours) return advanced;
    const distinct = unique(hours);
    return distinct.length <= MAX_DAILY_TIMES ? { mode: 'daily', times: distinct.map((h) => ({ hour: h, minute })) } : advanced;
  }

  const minute = intField(min, 0, 59);
  const h = intField(hour, 0, 23);
  if (minute === null || h === null) return advanced;
  const time = { hour: h, minute };

  if (dom === '*') {
    const days = listValues(dow, 0, 7);
    return days ? { mode: 'weekly', days: unique(days.map((d) => d % 7)) as Weekday[], time } : advanced;
  }
  if (dow === '*') {
    const days = listValues(dom, 1, 31);
    if (!days) return advanced;
    const distinct = unique(days);
    return distinct.length <= MAX_MONTHLY_DAYS ? { mode: 'monthly', days: distinct, time } : advanced;
  }
  return advanced;
}

/** Why a spec cannot be saved, as a sentence; null when it can. */
export function validateSpec(spec: ScheduleSpec): string | null {
  switch (spec.mode) {
    case 'minutes':
      return (MINUTE_STEPS as readonly number[]).includes(spec.every) ? null : 'Choose 5, 10, 15, 20 or 30 minutes.';
    case 'hours':
      if (!(HOUR_STEPS as readonly number[]).includes(spec.every)) return 'Choose 1, 2, 3, 4, 6, 8 or 12 hours.';
      return isInt(spec.minute, 0, 59) ? null : 'The minute must be a number from 0 to 59.';
    case 'daily': {
      if (spec.times.length === 0) return 'Add at least one time.';
      if (spec.times.length > MAX_DAILY_TIMES) return `A schedule can have up to ${MAX_DAILY_TIMES} times a day.`;
      if (!spec.times.every(validTime)) return 'Enter a time.';
      if (new Set(spec.times.map((t) => t.hour)).size !== spec.times.length) return 'Two of the times are in the same hour. Remove one.';
      if (spec.times.some((t) => t.minute !== spec.times[0]!.minute)) {
        return 'Times in one schedule must share the same minute (09:00 and 17:00, not 09:00 and 17:30). Add a second schedule for the other time.';
      }
      return null;
    }
    case 'weekly':
      if (spec.days.length === 0) return 'Choose at least one day.';
      if (!spec.days.every((d) => isInt(d, 0, 6))) return 'Choose days from Monday to Sunday.';
      return validTime(spec.time) ? null : 'Enter a time.';
    case 'monthly':
      if (spec.days.length === 0) return 'Choose at least one day of the month.';
      if (unique(spec.days).length > MAX_MONTHLY_DAYS) return `Choose up to ${MAX_MONTHLY_DAYS} days of the month.`;
      if (!spec.days.every((d) => isInt(d, 1, 31))) return 'Days of the month are 1 to 31.';
      return validTime(spec.time) ? null : 'Enter a time.';
    case 'advanced': {
      const text = spec.cron.trim();
      if (!text) return 'Enter a cron expression.';
      const count = text.split(/\s+/).length;
      return count === 5 ? null : `A cron expression has 5 fields (minute, hour, day of month, month, day of week); this one has ${count}.`;
    }
  }
}

/** A spec in the order the builder keeps it: times, days sorted and without repeats. */
export function normalizeSpec(spec: ScheduleSpec): ScheduleSpec {
  switch (spec.mode) {
    case 'daily':
      return { mode: 'daily', times: [...spec.times].sort((a, b) => a.hour - b.hour || a.minute - b.minute) };
    case 'weekly':
      return { ...spec, days: unique(spec.days) as Weekday[] };
    case 'monthly':
      return { ...spec, days: unique(spec.days) };
    default:
      return spec;
  }
}

const DEFAULT_TIME: TimeOfDay = { hour: 9, minute: 0 };

/** The time of day a spec carries, to keep across a change of mode. */
function timeOf(spec: ScheduleSpec): TimeOfDay {
  switch (spec.mode) {
    case 'daily':
      return spec.times[0] && validTime(spec.times[0]) ? spec.times[0] : DEFAULT_TIME;
    case 'weekly':
    case 'monthly':
      return validTime(spec.time) ? spec.time : DEFAULT_TIME;
    case 'hours':
      return { hour: DEFAULT_TIME.hour, minute: isInt(spec.minute, 0, 59) ? spec.minute : 0 };
    default:
      return DEFAULT_TIME;
  }
}

/**
 * The spec after choosing another mode, keeping what carries over: the time
 * of day between Daily, Weekly and Monthly, the minute to and from Hourly.
 * To Advanced it is the current expression (`currentCron`, the last valid one).
 * From Advanced, parse the expression first (`cronToSpec`) and pass the result.
 */
export function switchMode(spec: ScheduleSpec, mode: ScheduleMode, currentCron: string): ScheduleSpec {
  if (spec.mode === mode) return spec;
  const time = timeOf(spec);
  switch (mode) {
    case 'minutes':
      return { mode, every: 15 };
    case 'hours':
      return { mode, every: 1, minute: time.minute };
    case 'daily':
      return { mode, times: [time] };
    case 'weekly':
      return { mode, days: [1, 2, 3, 4, 5], time };
    case 'monthly':
      return { mode, days: [1], time };
    case 'advanced':
      return { mode, cron: validateSpec(spec) === null ? specToCron(spec) : currentCron };
  }
}

const two = (n: number) => String(n).padStart(2, '0');

/** `{ hour: 9, minute: 5 }` → `"09:05"`, the value of an `<input type="time">`. */
export function formatTimeOfDay(t: TimeOfDay): string {
  return validTime(t) ? `${two(t.hour)}:${two(t.minute)}` : '';
}

/** `"09:05"` → `{ hour: 9, minute: 5 }`; null for anything else. */
export function parseTimeOfDay(text: string): TimeOfDay | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(text);
  if (!m) return null;
  const t = { hour: Number(m[1]), minute: Number(m[2]) };
  return validTime(t) ? t : null;
}
