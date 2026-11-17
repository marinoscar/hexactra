// A sentence for the cron expressions the schedule builder writes (E32.7).
// Pure, English, 24-hour. Anything else reads "Custom schedule (<expr>)".

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const int = (s: string, min: number, max: number): number | null => {
  if (!/^\d{1,2}$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
};

/** `a,b,c` as numbers in range, or null. */
function list(s: string, min: number, max: number): number[] | null {
  const out: number[] = [];
  for (const part of s.split(',')) {
    const n = int(part, min, max);
    if (n === null) return null;
    out.push(n);
  }
  return out.length > 0 ? out : null;
}

/** `*\/n` as n, or null. */
function step(s: string, min: number, max: number): number | null {
  const m = /^\*\/(\d{1,2})$/.exec(s);
  return m ? int(m[1]!, min, max) : null;
}

/** "A", "A and B", "A, B and C". */
function join(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The days of a day-of-week field as a phrase, or null when it is not a plain range or list (7 is Sunday). */
function weekdays(field: string): string | null {
  const range = /^(\d)-(\d)$/.exec(field);
  if (range) {
    const a = int(range[1]!, 0, 7);
    const b = int(range[2]!, 0, 7);
    if (a === null || b === null || a >= b) return null;
    if ((a === 0 && b >= 6) || (a === 1 && b === 7)) return 'Every day';
    return `${DAYS[a % 7]} to ${DAYS[b % 7]}`;
  }
  const days = list(field, 0, 7);
  if (!days) return null;
  const unique = [...new Set(days.map((d) => d % 7))];
  if (unique.length === 7) return 'Every day';
  if (unique.length === 1) return `Every ${DAYS[unique[0]!]}`;
  return join(unique.map((d) => DAYS[d]!));
}

/**
 * What a 5-field cron expression means, for the patterns the schedule builder
 * writes: every N minutes, every N hours, daily, on week days, on days of the
 * month. Any other valid expression is "Custom schedule (<expr>)". It does not
 * validate: call it with an expression `scheduleProblem` accepted.
 */
export function describeCron(expr: string): string {
  const text = expr.trim().replace(/\s+/g, ' ');
  const custom = `Custom schedule (${text})`;
  const f = text.split(' ');
  if (f.length !== 5) return custom;
  const [min, hour, dom, month, dow] = f as [string, string, string, string, string];
  if (month !== '*') return custom;

  if (hour === '*' && dom === '*' && dow === '*') {
    const n = step(min, 1, 59);
    if (n !== null) return n === 1 ? 'Every minute' : `Every ${n} minutes`;
    const m = int(min, 0, 59);
    if (m !== null) return m === 0 ? 'Every hour' : `Every hour at minute ${m}`;
    return custom;
  }

  const m = int(min, 0, 59);
  if (m === null) return custom;

  const everyHours = step(hour, 1, 23);
  if (everyHours !== null) {
    if (dom !== '*' || dow !== '*') return custom;
    const base = everyHours === 1 ? 'Every hour' : `Every ${everyHours} hours`;
    return m === 0 ? base : `${base} at minute ${m}`;
  }

  const h = int(hour, 0, 23);
  if (h === null) return custom;
  const at = `at ${pad(h)}:${pad(m)}`;

  if (dom === '*' && dow === '*') return `Every day ${at}`;
  if (dom === '*') {
    const days = weekdays(dow);
    return days ? `${days} ${at}` : custom;
  }
  if (dow === '*') {
    const days = list(dom, 1, 31);
    if (!days) return custom;
    return `On ${days.length === 1 ? 'day' : 'days'} ${join(days.map(String))} of every month ${at}`;
  }
  return custom;
}
