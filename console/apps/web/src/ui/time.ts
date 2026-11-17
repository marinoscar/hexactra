// Dates and times in the profile time zone. The zone comes from the platform's
// display-zone store (`@marinoscar/platform-web/timezone/headless`), which
// `UserTimeZoneSync` (App.tsx) feeds from the signed-in user's profile and
// which falls back to the browser's zone.
import { getDisplayTimeZone, toValidDate, useDisplayTimeZone, zonedDateKey, type DateInput } from '@marinoscar/platform-web/timezone/headless';

/**
 * The profile time zone (an IANA id), re-rendering the component when the
 * profile changes it. Call it in a component that renders `formatDateTime` or
 * `formatRelative` text, so a saved profile re-renders its times.
 */
export function useProfileTimeZone(): string {
  return useDisplayTimeZone();
}

/** What an empty or invalid date renders. */
export const NO_DATE = 'n/a';

export interface FormatDateTimeOptions extends Intl.DateTimeFormatOptions {
  /** The BCP 47 locale; default: the runtime's. */
  locale?: string;
  /** What an empty or invalid value renders; default `"n/a"`. */
  fallback?: string;
}

function format(date: Date, options: Intl.DateTimeFormatOptions, locale: string | undefined): string {
  const timeZone = options.timeZone ?? getDisplayTimeZone();
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(date);
  } catch {
    // A zone or option the runtime does not know: UTC, then the plain ISO text.
    try {
      return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(date);
    } catch {
      return date.toISOString();
    }
  }
}

/**
 * A date and time in the profile time zone ("Nov 17, 2026, 2:05 PM"). An
 * empty or invalid value renders `"n/a"`; it never throws.
 *
 * @param iso - an ISO 8601 string, a `Date` or epoch milliseconds.
 * @param opts - `Intl.DateTimeFormat` options (default medium date, short time), `timeZone` to leave the profile zone, `locale`, `fallback`.
 */
export function formatDateTime(iso: DateInput, opts: FormatDateTimeOptions = {}): string {
  const { locale, fallback = NO_DATE, ...rest } = opts;
  const date = toValidDate(iso);
  if (!date) return fallback;
  const hasField = Object.keys(rest).some((k) => k !== 'timeZone' && k !== 'hour12' && k !== 'hourCycle');
  return format(date, hasField ? rest : { dateStyle: 'medium', timeStyle: 'short', ...rest }, locale);
}

/** A time of day in the profile time zone ("2:05 PM"); `"n/a"` for an empty or invalid value. */
export function formatTime(iso: DateInput, opts: FormatDateTimeOptions = {}): string {
  return formatDateTime(iso, { timeStyle: 'short', ...opts });
}

export interface FormatRelativeOptions {
  /** The zone the day boundary and the clock times use; default: the profile zone. */
  timeZone?: string;
  /** The locale of the date and clock parts; default `en-US` (the words are English). */
  locale?: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A moment relative to `now`: "just now", "5 min ago", "in 3 h", "yesterday
 * 14:05", "tomorrow 09:00", then a date ("Nov 3, 14:05"; with the year when it
 * differs). Days are calendar days of the profile time zone, so 23:50 last
 * night is "yesterday", never "20 min ago" once an hour has passed. An empty
 * or invalid value renders `"n/a"`; it never throws.
 *
 * @param iso - an ISO 8601 string, a `Date` or epoch milliseconds.
 * @param now - the current moment (a `Date` or epoch milliseconds); default: now.
 */
export function formatRelative(iso: DateInput, now: Date | number = Date.now(), opts: FormatRelativeOptions = {}): string {
  const date = toValidDate(iso);
  const nowDate = toValidDate(now);
  if (!date || !nowDate) return NO_DATE;
  const timeZone = opts.timeZone ?? getDisplayTimeZone();
  const diff = date.getTime() - nowDate.getTime();
  const abs = Math.abs(diff);
  const past = diff <= 0;
  if (abs < MINUTE) return 'just now';

  const locale = opts.locale ?? 'en-US';
  const clock = () => format(date, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }, locale);
  const dayKey = zonedDateKey(date, timeZone);
  const today = zonedDateKey(nowDate, timeZone);
  const sameDay = dayKey !== null && dayKey === today;

  // Within the same calendar day, or less than an hour away across midnight: minutes and hours.
  if (sameDay || abs < HOUR) {
    if (abs < HOUR) {
      const min = Math.floor(abs / MINUTE);
      return past ? `${min} min ago` : `in ${min} min`;
    }
    const h = Math.floor(abs / HOUR);
    return past ? `${h} h ago` : `in ${h} h`;
  }
  if (dayKey !== null && dayKey === zonedDateKey(new Date(nowDate.getTime() - DAY), timeZone) && past) return `yesterday ${clock()}`;
  if (dayKey !== null && dayKey === zonedDateKey(new Date(nowDate.getTime() + DAY), timeZone) && !past) return `tomorrow ${clock()}`;

  const sameYear = dayKey !== null && today !== null && dayKey.slice(0, 4) === today.slice(0, 4);
  const day = format(date, sameYear ? { month: 'short', day: 'numeric', timeZone } : { year: 'numeric', month: 'short', day: 'numeric', timeZone }, locale);
  return `${day}, ${clock()}`;
}
