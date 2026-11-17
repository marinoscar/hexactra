import { useDisplayTimeZone, toValidDate, type DateInput } from '@marinoscar/platform-web/timezone/headless';
import { useEffect, useState } from 'react';

import { formatDateTime, formatRelative, NO_DATE } from './time';

export interface RelativeTimeProps {
  /** An ISO 8601 string (a `Date` or epoch milliseconds work too); empty or invalid renders "n/a". */
  iso: DateInput;
  /** Text before the relative time, inside the element ("next ", "started "). */
  prefix?: string;
}

/**
 * A moment as relative text ("5 min ago") in a `<time dateTime>` element, with
 * the absolute time in the profile time zone as its `title`. Re-renders once a
 * minute, and when the profile time zone changes.
 */
export function RelativeTime({ iso, prefix }: RelativeTimeProps) {
  const timeZone = useDisplayTimeZone();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const date = toValidDate(iso);
  if (!date) return <span>{NO_DATE}</span>;
  return (
    <time dateTime={date.toISOString()} title={formatDateTime(date, { timeZone })}>
      {prefix}
      {formatRelative(date, now, { timeZone })}
    </time>
  );
}
