import { nextFiring, tooFrequent, validTimezone } from '../src/schedules/cron';

describe('schedule cron', () => {
  it('computes the next firing in the schedule time zone', () => {
    const next = nextFiring('0 9 * * 1-5', 'America/Chicago', new Date('2026-11-14T12:00:00Z')); // a Saturday
    expect(next?.toISOString()).toBe('2026-11-16T15:00:00.000Z'); // Monday 09:00 CST
  });

  it('refuses invalid expressions, zones and over-frequent schedules', () => {
    expect(nextFiring('not a cron', 'UTC')).toBeNull();
    expect(nextFiring('0 0 * * * *', 'UTC')).toBeNull(); // 6 fields
    expect(validTimezone('Mars/Olympus')).toBe(false);
    expect(nextFiring('0 9 * * *', 'Mars/Olympus')).toBeNull();
    expect(tooFrequent('* * * * *', 'UTC')).toBe(true);
    expect(tooFrequent('*/5 * * * *', 'UTC')).toBe(false);
  });
});
