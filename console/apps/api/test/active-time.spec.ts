import { activeElapsedMs, timeBudgetExhausted } from '../src/runner/active-time';

const at = (ms: number) => new Date(ms);

describe('active time (#399)', () => {
  it('is the settled total while the run is not running', () => {
    expect(activeElapsedMs({ activeMs: 5_000, activeSince: null }, 1_000_000)).toBe(5_000);
  });

  it('adds the open stretch while it runs', () => {
    expect(activeElapsedMs({ activeMs: 5_000, activeSince: at(100_000) }, 160_000)).toBe(65_000);
  });

  it('never counts a negative stretch (clock skew)', () => {
    expect(activeElapsedMs({ activeMs: 0, activeSince: at(200_000) }, 100_000)).toBe(0);
  });

  it('compares the active time with the budget in minutes', () => {
    const run = { activeMs: 14 * 60_000, activeSince: at(0) };
    expect(timeBudgetExhausted(run, 15, 30_000)).toBe(false);
    expect(timeBudgetExhausted(run, 15, 61_000)).toBe(true);
  });
});
