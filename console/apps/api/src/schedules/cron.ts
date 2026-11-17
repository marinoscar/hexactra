import { CronTime } from 'cron';

/** Whether `tz` is an IANA time zone the runtime knows. */
export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The next firing after `after` of a 5-field cron expression in `tz`, or `null` if invalid. */
export function nextFiring(expr: string, tz: string, after: Date = new Date()): Date | null {
  if (!validTimezone(tz)) return null;
  if (expr.trim().split(/\s+/).length !== 5) return null;
  try {
    const t = new CronTime(expr, tz);
    // CronTime counts from "now"; step from `after` by asking for the next date after it.
    const next = t.getNextDateFrom(after, tz);
    return next.toJSDate();
  } catch {
    return null;
  }
}

/** At most one firing per minute: refuse expressions that fire more often than every 5 minutes. */
export function tooFrequent(expr: string, tz: string): boolean {
  const a = nextFiring(expr, tz);
  if (!a) return false;
  const b = nextFiring(expr, tz, a);
  return b !== null && b.getTime() - a.getTime() < 5 * 60_000;
}

/** The next `count` firings after `after`, ascending; empty when the expression or the zone is invalid. */
export function nextFirings(expr: string, tz: string, count: number, after: Date = new Date()): Date[] {
  const out: Date[] = [];
  let from = after;
  for (let i = 0; i < count; i++) {
    const next = nextFiring(expr, tz, from);
    // A firing that does not move forward would loop for ever: stop.
    if (!next || next.getTime() <= from.getTime()) break;
    out.push(next);
    from = next;
  }
  return out;
}

/** Why a schedule is refused, or `null` when it is fine. The codes are the API's (`schedules.errors.ts`). */
export type ScheduleProblem = { code: 'INVALID_TIMEZONE' | 'INVALID_CRON' | 'CRON_TOO_FREQUENT'; message: string };

/** The one check every path uses (create, update, the task's schedule set, the preview). */
export function scheduleProblem(expr: string, tz: string): ScheduleProblem | null {
  if (!validTimezone(tz)) return { code: 'INVALID_TIMEZONE', message: `Unknown time zone "${tz}"` };
  if (!nextFiring(expr, tz)) return { code: 'INVALID_CRON', message: 'Use a 5-field cron expression, e.g. "0 9 * * 1-5"' };
  if (tooFrequent(expr, tz)) return { code: 'CRON_TOO_FREQUENT', message: 'A schedule may fire at most every 5 minutes' };
  return null;
}
