/**
 * The reminder schedule of a request waiting for its person (#298), pure:
 * computed from the request's own window (`waitingSince` to the fabric
 * handoff's `expires_at`). The job that sends them is run-reminders.ts.
 */

const MIN = 60_000;
/** "Remind me in 15 min". */
export const SNOOZE_MS = 15 * MIN;
/** Snooze is offered only while this much time is left (the final reminder still fits after it). */
export const SNOOZE_MIN_LEFT_MS = 20 * MIN;
/** Reminders per request, snoozes included. */
export const MAX_REMINDERS = 5;
/** Points closer than this to the request, or to each other, are dropped. */
const MIN_GAP_MS = 3 * MIN;
/** No reminder this close to expiry: there would be no time to act on it. */
const TOO_LATE_MS = 1 * MIN;
/** A reminder sent with this little time left says so ("expires in N min"). */
export const FINAL_WINDOW_MS = 6 * MIN;

/**
 * The reminder times of one request, ascending. With a known expiry: a nudge at
 * 25 % of the window (3 to 15 min in), a midpoint for windows of 2 h or more,
 * and a final one 5 min (20 % of a short window) before expiry. Without one:
 * 10 and 60 min in.
 */
export function reminderPoints(waitingSince: Date, expiresAt: Date | null): Date[] {
  const start = waitingSince.getTime();
  if (!expiresAt) return [start + 10 * MIN, start + 60 * MIN].map((t) => new Date(t));
  const end = expiresAt.getTime();
  const w = end - start;
  if (w <= 0) return [];
  const nudge = start + Math.min(15 * MIN, Math.max(MIN_GAP_MS, w * 0.25));
  const final = end - Math.min(5 * MIN, w * 0.2);
  const candidates = [nudge, ...(w >= 120 * MIN ? [start + w / 2] : []), final].sort((a, b) => a - b);
  const out: number[] = [];
  // Walk from the end so the final reminder always survives a crowded window.
  for (const t of [...candidates].reverse()) {
    if (t < start + MIN_GAP_MS || t > end - TOO_LATE_MS) continue;
    if (out.length && out[out.length - 1] - t < MIN_GAP_MS) continue;
    out.push(t);
  }
  return out.reverse().map((t) => new Date(t));
}

/** What the schedule needs to know about a waiting run. */
export interface ReminderState {
  waitingSince: Date;
  expiresAt: Date | null;
  remindedAt: Date | null;
  reminderCount: number;
  snoozedUntil: Date | null;
}

/** A reminder is due now: a snooze ran out, or a scheduled point passed since the last one. */
export function reminderDue(s: ReminderState, now: Date): boolean {
  if (s.reminderCount >= MAX_REMINDERS) return false;
  if (s.expiresAt && s.expiresAt.getTime() - now.getTime() <= TOO_LATE_MS) return false;
  if (s.snoozedUntil) return s.snoozedUntil.getTime() <= now.getTime();
  const since = (s.remindedAt ?? s.waitingSince).getTime();
  return reminderPoints(s.waitingSince, s.expiresAt).some((p) => p.getTime() > since && p.getTime() <= now.getTime());
}

/** When to look again after `now` (a pending snooze wins: no nudge inside it), or `null`. */
export function nextReminderAt(s: ReminderState, now: Date): Date | null {
  if (s.reminderCount >= MAX_REMINDERS) return null;
  if (s.snoozedUntil && s.snoozedUntil.getTime() > now.getTime()) return s.snoozedUntil;
  const after = Math.max(now.getTime(), (s.remindedAt ?? s.waitingSince).getTime());
  return reminderPoints(s.waitingSince, s.expiresAt).find((p) => p.getTime() > after) ?? null;
}

/** "Remind me in 15 min" fits: at least 20 min left (or no known expiry) and a reminder left to send. */
export function canSnooze(expiresAt: Date | null, now: Date, reminderCount = 0): boolean {
  if (reminderCount >= MAX_REMINDERS) return false;
  return !expiresAt || expiresAt.getTime() - now.getTime() >= SNOOZE_MIN_LEFT_MS;
}

/** The reminder columns of a run that starts waiting now. */
export function startWaiting(now: Date, expiresAt: Date | null) {
  const s: ReminderState = { waitingSince: now, expiresAt, remindedAt: null, reminderCount: 0, snoozedUntil: null };
  return { waitingSince: now, handoffExpiresAt: expiresAt, remindedAt: null, reminderCount: 0, snoozedUntil: null, remindAt: nextReminderAt(s, now) };
}

/** The reminder columns of a run that stops waiting (answered, resumed, cancelled, failed). */
export const STOP_WAITING = { remindAt: null, snoozedUntil: null } as const;
