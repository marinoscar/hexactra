// The reminder schedule of a request waiting for its person (#298): when each
// reminder fires for windows from the fabric's 10 min default to its 24 h
// maximum, when one is due, what comes next, and when snoozing is offered.
import {
  MAX_REMINDERS,
  canSnooze,
  nextReminderAt,
  reminderDue,
  reminderPoints,
  startWaiting,
  type ReminderState,
} from '../src/tasks/run-reminders';

const MIN = 60_000;
const T0 = new Date('2026-11-15T12:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * MIN);
const offsets = (pts: Date[]) => pts.map((p) => (p.getTime() - T0.getTime()) / MIN);
const state = (expiresMin: number | null, patch: Partial<ReminderState> = {}): ReminderState => ({
  waitingSince: T0,
  expiresAt: expiresMin === null ? null : at(expiresMin),
  remindedAt: null,
  reminderCount: 0,
  snoozedUntil: null,
  ...patch,
});

describe('reminderPoints', () => {
  it('10 min (the fabric default): a nudge at 3 min and a final one at 8 min', () => {
    expect(offsets(reminderPoints(T0, at(10)))).toEqual([3, 8]);
  });
  it('30 min: a nudge at 7.5 min and a final one 5 min before expiry', () => {
    expect(offsets(reminderPoints(T0, at(30)))).toEqual([7.5, 25]);
  });
  it('4 h: nudge at 15 min, midpoint, final', () => {
    expect(offsets(reminderPoints(T0, at(240)))).toEqual([15, 120, 235]);
  });
  it('24 h (the maximum): nudge at 15 min, midpoint at 12 h, final 5 min before', () => {
    expect(offsets(reminderPoints(T0, at(1440)))).toEqual([15, 720, 1435]);
  });
  it('a crowded short window keeps the final reminder only, a tiny one none', () => {
    expect(offsets(reminderPoints(T0, at(5)))).toEqual([4]);
    expect(reminderPoints(T0, at(2))).toEqual([]);
    expect(reminderPoints(T0, at(-1))).toEqual([]);
  });
  it('no known expiry: 10 and 60 min', () => {
    expect(offsets(reminderPoints(T0, null))).toEqual([10, 60]);
  });
});

describe('reminderDue and nextReminderAt', () => {
  it('starts with the first point and is due once it passes', () => {
    expect(startWaiting(T0, at(30)).remindAt).toEqual(at(7.5));
    expect(reminderDue(state(30), at(7))).toBe(false);
    expect(reminderDue(state(30), at(8))).toBe(true);
  });
  it('after a reminder, the next point; overdue points collapse into one reminder', () => {
    const s = state(30, { remindedAt: at(26), reminderCount: 1 });
    expect(reminderDue(s, at(26))).toBe(false);
    expect(nextReminderAt(state(30, { remindedAt: at(8), reminderCount: 1 }), at(8))).toEqual(at(25));
    expect(nextReminderAt(s, at(26))).toBeNull();
  });
  it('a snooze wins: nothing inside it, due when it runs out', () => {
    const s = state(240, { snoozedUntil: at(20) });
    expect(nextReminderAt(s, at(5))).toEqual(at(20));
    expect(reminderDue(s, at(16))).toBe(false);
    expect(reminderDue(s, at(20))).toBe(true);
  });
  it('never in the last minute, never past the cap', () => {
    expect(reminderDue(state(10, { snoozedUntil: at(9.5) }), at(9.5))).toBe(false);
    expect(reminderDue(state(240, { reminderCount: MAX_REMINDERS }), at(16))).toBe(false);
    expect(nextReminderAt(state(240, { reminderCount: MAX_REMINDERS }), at(16))).toBeNull();
  });
});

describe('canSnooze', () => {
  it('only with 20 min or more left (or no known expiry) and reminders to spare', () => {
    expect(canSnooze(at(30), T0)).toBe(true);
    expect(canSnooze(at(19), T0)).toBe(false);
    expect(canSnooze(null, T0)).toBe(true);
    expect(canSnooze(null, T0, MAX_REMINDERS)).toBe(false);
  });
});
