// The schedule builder's model (#425): each mode's cron expression and its
// exact inverse, equivalent spellings, what stays in Advanced, validation.
import { describe, expect, it } from 'vitest';

import { draftFromSchedule, draftToItem, newScheduleDraft } from '../schedule/draft';
import {
  HOUR_STEPS,
  MINUTE_STEPS,
  cronToSpec,
  formatTimeOfDay,
  normalizeSpec,
  parseTimeOfDay,
  specToCron,
  switchMode,
  validateSpec,
  type ScheduleSpec,
  type Weekday,
} from '../schedule/model';

const at = (hour: number, minute = 0) => ({ hour, minute });

describe('the mapping table, both ways', () => {
  const rows: Array<[ScheduleSpec, string]> = [
    [{ mode: 'minutes', every: 15 }, '*/15 * * * *'],
    [{ mode: 'hours', every: 2, minute: 30 }, '30 */2 * * *'],
    [{ mode: 'hours', every: 1, minute: 30 }, '30 * * * *'],
    [{ mode: 'daily', times: [at(9, 30)] }, '30 9 * * *'],
    [{ mode: 'daily', times: [at(9), at(17)] }, '0 9,17 * * *'],
    [{ mode: 'weekly', days: [1, 2, 3, 4, 5], time: at(9) }, '0 9 * * 1-5'],
    [{ mode: 'weekly', days: [1, 3, 5], time: at(9) }, '0 9 * * 1,3,5'],
    [{ mode: 'weekly', days: [0, 6], time: at(10, 15) }, '15 10 * * 0,6'],
    [{ mode: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: at(7) }, '0 7 * * 0-6'],
    [{ mode: 'monthly', days: [1, 15], time: at(8) }, '0 8 1,15 * *'],
    [{ mode: 'advanced', cron: '0 9 1 1 *' }, '0 9 1 1 *'],
  ];
  it.each(rows)('%j ↔ %s', (spec, cron) => {
    expect(specToCron(spec)).toBe(cron);
    expect(cronToSpec(cron)).toEqual(spec);
  });
});

describe('cronToSpec', () => {
  it('reads equivalent spellings', () => {
    const weekdays = { mode: 'weekly', days: [1, 2, 3, 4, 5], time: at(9) };
    expect(cronToSpec('0 9 * * 1,2,3,4,5')).toEqual(weekdays);
    expect(cronToSpec('0  9 * *   1-3,4,5 ')).toEqual(weekdays);
    expect(cronToSpec('0 9 * * 7')).toEqual({ mode: 'weekly', days: [0], time: at(9) });
    expect(cronToSpec('0 9 * * 0,7')).toEqual({ mode: 'weekly', days: [0], time: at(9) });
    expect(cronToSpec('0 9 * * 6-7')).toEqual({ mode: 'weekly', days: [0, 6], time: at(9) });
    expect(cronToSpec('30 */1 * * *')).toEqual({ mode: 'hours', every: 1, minute: 30 });
    expect(cronToSpec('0 17,9 * * *')).toEqual({ mode: 'daily', times: [at(9), at(17)] });
    expect(cronToSpec('0 8 15,1 * *')).toEqual({ mode: 'monthly', days: [1, 15], time: at(8) });
    expect(cronToSpec('0 8 1-3 * *')).toEqual({ mode: 'monthly', days: [1, 2, 3], time: at(8) });
  });

  it.each([
    '0 9 * * MON-FRI', // names
    '0 9 1 1 *', // a month
    '0 9 1 * 1', // day of month and day of week
    '*/7 * * * *', // a step the builder does not offer
    '*/15 9 * * *',
    '0 */5 * * *',
    '0 9-17 * * 1-5', // a range of hours on weekdays
    '0 6,9,12,15,18 * * *', // five times a day
    '0 8 1-10 * *', // more than five days of the month
    '0 9 * * 1/2',
    '0 9 * * 8',
    '0 9 32 * *',
    '60 9 * * *',
    '* * * * *',
    '0 9 * *',
    '0 0 9 * * *',
    'every day at nine',
    '',
  ])('leaves %j in Advanced, unchanged', (cron) => {
    expect(cronToSpec(cron)).toEqual({ mode: 'advanced', cron });
  });
});

describe('round trip: cronToSpec(specToCron(s)) equals s', () => {
  const specs: ScheduleSpec[] = [];
  for (const every of MINUTE_STEPS) specs.push({ mode: 'minutes', every });
  for (const every of HOUR_STEPS) for (let minute = 0; minute < 60; minute++) specs.push({ mode: 'hours', every, minute });
  // Daily: every single time on the quarter hour, and sets of 2 to 4 hours.
  for (let hour = 0; hour < 24; hour++) for (const minute of [0, 15, 30, 59]) specs.push({ mode: 'daily', times: [at(hour, minute)] });
  for (const hours of [[9, 17], [0, 23], [6, 12, 18], [0, 6, 12, 18], [8, 9, 10, 11]]) for (const minute of [0, 45]) specs.push({ mode: 'daily', times: hours.map((h) => at(h, minute)) });
  // Weekly: every one of the 127 sets of days.
  for (let mask = 1; mask < 128; mask++) {
    const days = [0, 1, 2, 3, 4, 5, 6].filter((d) => mask & (1 << d)) as Weekday[];
    specs.push({ mode: 'weekly', days, time: at(mask % 24, (mask * 7) % 60) });
  }
  // Monthly: every single day, and sets of up to five.
  for (let day = 1; day <= 31; day++) specs.push({ mode: 'monthly', days: [day], time: at(day % 24, day) });
  for (const days of [[1, 15], [1, 2, 3], [29, 30, 31], [1, 8, 15, 22, 29], [5, 10, 20, 25, 31]]) specs.push({ mode: 'monthly', days, time: at(8, 5) });

  it(`holds for ${specs.length} builder specs, each valid and each with a 5-field expression`, () => {
    expect(specs.length).toBeGreaterThan(650);
    for (const spec of specs) {
      expect(validateSpec(spec), JSON.stringify(spec)).toBeNull();
      const cron = specToCron(spec);
      expect(cron.split(' ')).toHaveLength(5);
      expect(cronToSpec(cron), cron).toEqual(normalizeSpec(spec));
    }
  });

  it('normalises what the user picked in another order', () => {
    const picked: ScheduleSpec = { mode: 'weekly', days: [5, 1, 3, 1], time: at(9) };
    expect(specToCron(picked)).toBe('0 9 * * 1,3,5');
    expect(cronToSpec(specToCron(picked))).toEqual(normalizeSpec(picked));
    expect(specToCron({ mode: 'monthly', days: [15, 1], time: at(8) })).toBe('0 8 1,15 * *');
  });
});

describe('validateSpec', () => {
  it.each<[string, ScheduleSpec, RegExp]>([
    ['no weekday', { mode: 'weekly', days: [], time: at(9) }, /at least one day/],
    ['no day of the month', { mode: 'monthly', days: [], time: at(9) }, /at least one day of the month/],
    ['more than 5 monthly days', { mode: 'monthly', days: [1, 2, 3, 4, 5, 6], time: at(9) }, /up to 5 days/],
    ['a day of the month out of range', { mode: 'monthly', days: [32], time: at(9) }, /1 to 31/],
    ['daily times at different minutes', { mode: 'daily', times: [at(9, 0), at(17, 30)] }, /same minute.*second schedule/],
    ['two daily times in one hour', { mode: 'daily', times: [at(9, 0), at(9, 0)] }, /same hour/],
    ['no daily time', { mode: 'daily', times: [] }, /at least one time/],
    ['five daily times', { mode: 'daily', times: [at(1), at(2), at(3), at(4), at(5)] }, /up to 4 times/],
    ['a minute out of range', { mode: 'hours', every: 2, minute: 60 }, /0 to 59/],
    ['a negative minute', { mode: 'hours', every: 2, minute: -1 }, /0 to 59/],
    ['an empty minute', { mode: 'hours', every: 2, minute: Number.NaN }, /0 to 59/],
    ['a time out of range', { mode: 'weekly', days: [1], time: at(24) }, /Enter a time/],
    ['an interval the server refuses', { mode: 'minutes', every: 1 as never }, /5, 10, 15, 20 or 30/],
    ['an empty expression', { mode: 'advanced', cron: '  ' }, /Enter a cron expression/],
    ['an expression of four fields', { mode: 'advanced', cron: '0 9 * *' }, /5 fields.*has 4/],
  ])('%s returns a message', (_name, spec, message) => {
    expect(validateSpec(spec)).toMatch(message);
  });

  it('accepts any five fields in Advanced: the server judges them', () => {
    expect(validateSpec({ mode: 'advanced', cron: ' 0 9 * * MON-FRI ' })).toBeNull();
    expect(specToCron({ mode: 'advanced', cron: ' 0  9 * * MON-FRI ' })).toBe('0 9 * * MON-FRI');
  });
});

describe('switchMode', () => {
  it('keeps the time of day between Daily, Weekly and Monthly', () => {
    const daily: ScheduleSpec = { mode: 'daily', times: [at(9, 30)] };
    const weekly = switchMode(daily, 'weekly', '30 9 * * *');
    expect(weekly).toEqual({ mode: 'weekly', days: [1, 2, 3, 4, 5], time: at(9, 30) });
    expect(switchMode(weekly, 'monthly', '')).toEqual({ mode: 'monthly', days: [1], time: at(9, 30) });
    expect(switchMode(weekly, 'daily', '')).toEqual({ mode: 'daily', times: [at(9, 30)] });
    expect(switchMode(weekly, 'hours', '')).toEqual({ mode: 'hours', every: 1, minute: 30 });
    expect(switchMode(weekly, 'minutes', '')).toEqual({ mode: 'minutes', every: 15 });
  });
  it('shows the current expression in Advanced, and the last valid one for an incomplete spec', () => {
    expect(switchMode({ mode: 'weekly', days: [1, 2, 3, 4, 5], time: at(9) }, 'advanced', 'unused')).toEqual({ mode: 'advanced', cron: '0 9 * * 1-5' });
    expect(switchMode({ mode: 'weekly', days: [], time: at(9) }, 'advanced', '0 9 * * 1')).toEqual({ mode: 'advanced', cron: '0 9 * * 1' });
  });
});

describe('time of day text', () => {
  it('formats and parses the value of a time input', () => {
    expect(formatTimeOfDay(at(9, 5))).toBe('09:05');
    expect(parseTimeOfDay('17:30')).toEqual(at(17, 30));
    expect(parseTimeOfDay('17:30:00')).toEqual(at(17, 30));
    expect(parseTimeOfDay('')).toBeNull();
    expect(parseTimeOfDay('25:00')).toBeNull();
  });
});

describe('drafts', () => {
  it('a new draft is daily at 09:00 in the profile zone', () => {
    expect(newScheduleDraft('America/Costa_Rica')).toEqual({ cron: '0 9 * * *', timezone: 'America/Costa_Rica', enabled: true, concurrency: 'skip', policyId: null });
  });
  it('maps a saved schedule to a draft and back to the API item', () => {
    const draft = draftFromSchedule({ id: 'sc1', cron: '0 9 * * 1-5', timezone: 'Europe/Madrid', enabled: false, concurrency: 'queue', policyId: 'builtin:economy' });
    expect(draftToItem(draft)).toEqual({ id: 'sc1', cron: '0 9 * * 1-5', timezone: 'Europe/Madrid', enabled: false, concurrency: 'queue', policyId: 'builtin:economy' });
    expect(draftToItem(newScheduleDraft('UTC'))).toEqual({ cron: '0 9 * * *', timezone: 'UTC', enabled: true, concurrency: 'skip', policyId: null });
  });
});
