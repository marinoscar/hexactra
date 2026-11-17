// The schedule preview (#424): the sentence for each pattern the schedule
// builder writes, the next firings in the schedule's zone (across a
// daylight-saving change), and the typed answer for input that would be refused.
import { nextFirings } from '../src/schedules/cron';
import { describeCron } from '../src/schedules/cron-describe';
import { previewSchedule, previewScheduleSchema } from '../src/schedules/schedules.service';

describe('describeCron', () => {
  it.each([
    ['*/15 * * * *', 'Every 15 minutes'],
    ['0 */2 * * *', 'Every 2 hours'],
    ['30 9 * * *', 'Every day at 09:30'],
    ['0 9 * * 1-5', 'Monday to Friday at 09:00'],
    ['0 9 * * 1,3,5', 'Monday, Wednesday and Friday at 09:00'],
    ['0 8 1 * *', 'On day 1 of every month at 08:00'],
    ['0 8 1,15 * *', 'On days 1 and 15 of every month at 08:00'],
    ['5 4 * 2 *', 'Custom schedule (5 4 * 2 *)'],
  ])('%s reads "%s"', (cron, text) => {
    expect(describeCron(cron)).toBe(text);
  });

  it.each([
    ['0 * * * *', 'Every hour'],
    ['20 * * * *', 'Every hour at minute 20'],
    ['30 */6 * * *', 'Every 6 hours at minute 30'],
    ['0 7 * * 6,0', 'Saturday and Sunday at 07:00'],
    ['0 7 * * 7', 'Every Sunday at 07:00'],
    ['15 18 * * 0-6', 'Every day at 18:15'],
    ['0 9 1,15,28 * *', 'On days 1, 15 and 28 of every month at 09:00'],
    ['  0   9 * *  1-5 ', 'Monday to Friday at 09:00'],
  ])('also reads %s as "%s"', (cron, text) => {
    expect(describeCron(cron)).toBe(text);
  });

  it.each(['0 9 1 * 1', '0 9-17 * * *', '0,30 9 * * *', '0 9 * * MON', '0 9 L * *', '0 9 * * 5-1', '0 9 32 * *', 'nonsense'])('falls back to "Custom schedule" for %s', (cron) => {
    expect(describeCron(cron)).toBe(`Custom schedule (${cron})`);
  });
});

describe('nextFirings', () => {
  it('returns the asked number of instants, ascending, and none for an invalid expression or zone', () => {
    const next = nextFirings('*/10 * * * *', 'UTC', 4, new Date('2026-06-01T00:03:00Z'));
    expect(next.map((d) => d.toISOString())).toEqual(['2026-06-01T00:10:00.000Z', '2026-06-01T00:20:00.000Z', '2026-06-01T00:30:00.000Z', '2026-06-01T00:40:00.000Z']);
    expect(nextFirings('nope', 'UTC', 3)).toEqual([]);
    expect(nextFirings('0 9 * * *', 'Mars/Olympus', 3)).toEqual([]);
  });
});

describe('previewSchedule', () => {
  it('lists the next firings in the given zone across the March daylight-saving change', () => {
    // New York moves from UTC-5 to UTC-4 on Sunday 8 March 2026: 09:00 local is 14:00Z before, 13:00Z from then on.
    const p = previewSchedule('0 9 * * *', 'America/New_York', 4, new Date('2026-03-06T15:00:00Z'));
    expect(p).toEqual({
      valid: true,
      cron: '0 9 * * *',
      timezone: 'America/New_York',
      description: 'Every day at 09:00',
      next: ['2026-03-07T14:00:00.000Z', '2026-03-08T13:00:00.000Z', '2026-03-09T13:00:00.000Z', '2026-03-10T13:00:00.000Z'],
      // The day of the change is 23 hours long: the firings are not evenly spaced.
      intervalSeconds: null,
    });
    if (!p.valid) throw new Error('expected a valid preview');
    const times = p.next.map((t) => Date.parse(t));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('returns `count` firings and the interval of an evenly spaced schedule', () => {
    const p = previewSchedule('*/15 * * * *', 'Europe/Madrid', 10, new Date('2026-06-01T00:00:00Z'));
    expect(p).toMatchObject({ valid: true, description: 'Every 15 minutes', intervalSeconds: 900 });
    expect(p.valid && p.next).toHaveLength(10);
    expect(previewSchedule('0 */2 * * *', 'UTC', 1, new Date('2026-06-01T00:00:00Z'))).toMatchObject({ next: ['2026-06-01T02:00:00.000Z'], intervalSeconds: 7200 });
    expect(previewSchedule('0 9 * * 1-5', 'UTC', 5, new Date('2026-06-01T00:00:00Z'))).toMatchObject({ valid: true, intervalSeconds: null });
  });

  it('answers valid: false with the code saving would be refused with', () => {
    expect(previewSchedule('* * * * *', 'UTC', 5)).toEqual({ valid: false, code: 'CRON_TOO_FREQUENT', message: 'A schedule may fire at most every 5 minutes' });
    expect(previewSchedule('*/2 * * * *', 'UTC', 5)).toMatchObject({ valid: false, code: 'CRON_TOO_FREQUENT' });
    expect(previewSchedule('not a cron', 'UTC', 5)).toMatchObject({ valid: false, code: 'INVALID_CRON' });
    expect(previewSchedule('', 'UTC', 5)).toMatchObject({ valid: false, code: 'INVALID_CRON' });
    expect(previewSchedule('0 0 * * * *', 'UTC', 5)).toMatchObject({ valid: false, code: 'INVALID_CRON' });
    expect(previewSchedule('0 9 * * *', 'Mars/Olympus', 5)).toMatchObject({ valid: false, code: 'INVALID_TIMEZONE' });
  });

  it('accepts any text as the expression and bounds `count`', () => {
    expect(previewScheduleSchema.parse({ cron: '???' })).toEqual({ cron: '???', count: 5 });
    expect(previewScheduleSchema.safeParse({ cron: '0 9 * * *', count: 11 }).success).toBe(false);
    expect(previewScheduleSchema.safeParse({ cron: '0 9 * * *', count: 0 }).success).toBe(false);
  });
});
