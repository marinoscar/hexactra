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
