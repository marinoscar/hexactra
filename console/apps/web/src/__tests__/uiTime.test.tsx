// The kit's time formatting (apps/web/src/ui/time.ts, RelativeTime.tsx): every
// time renders in the profile time zone, the one `UserTimeZoneSync` stores.
import { act, render, screen } from '@testing-library/react';
import { setPreferredTimeZone } from '@marinoscar/platform-web/timezone/headless';
import { vi } from 'vitest';

import { RelativeTime, formatDateTime, formatRelative, formatTime } from '../ui';

// Tokyo is UTC+9 all year (no daylight saving), so the expectations are fixed.
beforeEach(() => setPreferredTimeZone('Asia/Tokyo'));
afterEach(() => {
  setPreferredTimeZone(null);
  vi.useRealTimers();
});

describe('formatDateTime', () => {
  it('uses the profile time zone', () => {
    // 20:30 UTC on the 17th is 05:30 on the 18th in Tokyo.
    expect(formatDateTime('2026-11-17T20:30:00Z', { locale: 'en-US' })).toBe('Nov 18, 2026, 5:30 AM');
    setPreferredTimeZone('America/Costa_Rica');
    expect(formatDateTime('2026-11-17T20:30:00Z', { locale: 'en-US' })).toBe('Nov 17, 2026, 2:30 PM');
  });

  it('takes Intl options and an explicit zone', () => {
    expect(formatDateTime('2026-11-17T20:30:00Z', { locale: 'en-US', timeZone: 'UTC' })).toBe('Nov 17, 2026, 8:30 PM');
    expect(formatDateTime('2026-11-17T20:30:00Z', { locale: 'en-US', dateStyle: 'long' })).toBe('November 18, 2026');
    expect(formatTime('2026-11-17T20:30:00Z', { locale: 'en-US' })).toBe('5:30 AM');
    expect(formatDateTime(new Date('2026-11-17T20:30:00Z'), { locale: 'en-US' })).toBe('Nov 18, 2026, 5:30 AM');
  });

  it('returns "n/a" for an empty or invalid value and never throws', () => {
    expect(formatDateTime(null)).toBe('n/a');
    expect(formatDateTime(undefined)).toBe('n/a');
    expect(formatDateTime('')).toBe('n/a');
    expect(formatDateTime('not a date')).toBe('n/a');
    expect(formatDateTime(Number.NaN)).toBe('n/a');
    expect(formatDateTime(null, { fallback: 'never' })).toBe('never');
    expect(() => formatDateTime('2026-11-17T20:30:00Z', { timeZone: 'Mars/Olympus_Mons' })).not.toThrow();
  });
});

describe('formatRelative', () => {
  // 03:00 UTC on the 17th: noon on the 17th in Tokyo.
  const now = new Date('2026-11-17T03:00:00Z');

  it('covers the past', () => {
    expect(formatRelative('2026-11-17T02:59:30Z', now)).toBe('just now');
    expect(formatRelative('2026-11-17T02:55:00Z', now)).toBe('5 min ago');
    expect(formatRelative('2026-11-17T02:00:01Z', now)).toBe('59 min ago');
    expect(formatRelative('2026-11-17T00:00:00Z', now)).toBe('3 h ago');
  });

  it('covers the future', () => {
    expect(formatRelative('2026-11-17T03:00:20Z', now)).toBe('just now');
    expect(formatRelative('2026-11-17T03:05:00Z', now)).toBe('in 5 min');
    expect(formatRelative('2026-11-17T06:00:00Z', now)).toBe('in 3 h');
    // 00:00 UTC on the 18th is 09:00 on the 18th in Tokyo.
    expect(formatRelative('2026-11-18T00:00:00Z', now)).toBe('tomorrow 09:00');
    expect(formatRelative('2026-11-20T00:00:00Z', now)).toBe('Nov 20, 09:00');
  });

  it('cuts days at midnight of the profile time zone, not of UTC', () => {
    // 05:05 UTC on the 16th is 14:05 on the 16th in Tokyo: yesterday, though under 24 h ago.
    expect(formatRelative('2026-11-16T05:05:00Z', now)).toBe('yesterday 14:05');
    // 14:50 UTC on the 16th is 23:50 in Tokyo, still the 16th there.
    expect(formatRelative('2026-11-16T14:50:00Z', now)).toBe('yesterday 23:50');
    // 15:10 UTC on the 16th is 00:10 on the 17th in Tokyo: today, though the UTC date is the 16th.
    expect(formatRelative('2026-11-16T15:10:00Z', now)).toBe('11 h ago');
    // Ten minutes across midnight stays minutes.
    expect(formatRelative('2026-11-16T14:55:00Z', new Date('2026-11-16T15:05:00Z'))).toBe('10 min ago');
    // In another zone the same two moments fall on the same day.
    expect(formatRelative('2026-11-16T05:05:00Z', now, { timeZone: 'UTC' })).toBe('yesterday 05:05');
    expect(formatRelative('2026-11-16T14:50:00Z', new Date('2026-11-16T20:00:00Z'), { timeZone: 'UTC' })).toBe('5 h ago');
  });

  it('falls back to a date, with the year when it differs', () => {
    expect(formatRelative('2026-11-03T05:05:00Z', now)).toBe('Nov 3, 14:05');
    expect(formatRelative('2025-12-31T05:05:00Z', now)).toBe('Dec 31, 2025, 14:05');
  });

  it('returns "n/a" for an empty or invalid value and never throws', () => {
    expect(formatRelative(null, now)).toBe('n/a');
    expect(formatRelative('nope', now)).toBe('n/a');
    expect(formatRelative('2026-11-17T03:00:00Z', Number.NaN)).toBe('n/a');
  });

  it('takes epoch milliseconds for now', () => {
    expect(formatRelative('2026-11-17T02:55:00Z', now.getTime())).toBe('5 min ago');
  });
});

describe('RelativeTime', () => {
  it('renders a <time> with the absolute time as its title, and re-renders once a minute', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T03:00:00Z'));
    render(<RelativeTime iso="2026-11-17T02:55:00Z" prefix="started " />);
    const time = screen.getByText('started 5 min ago');
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('datetime', '2026-11-17T02:55:00.000Z');
    expect(time.getAttribute('title')).toMatch(/Nov 17, 2026, 11:55/);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText('started 6 min ago')).toBeInTheDocument();
  });

  it('follows a change of the profile time zone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T03:00:00Z'));
    render(<RelativeTime iso="2026-11-16T05:05:00Z" />);
    expect(screen.getByText('yesterday 14:05')).toBeInTheDocument();
    act(() => setPreferredTimeZone('UTC'));
    expect(screen.getByText('yesterday 05:05')).toBeInTheDocument();
  });

  it('renders "n/a" for an empty or invalid value', () => {
    const { rerender } = render(<RelativeTime iso={null} />);
    expect(screen.getByText('n/a')).toBeInTheDocument();
    rerender(<RelativeTime iso="nope" />);
    expect(screen.getByText('n/a')).toBeInTheDocument();
  });
});
