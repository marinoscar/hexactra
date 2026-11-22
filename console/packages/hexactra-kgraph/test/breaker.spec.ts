// E46.12 (#786): each breaker rule at its boundary (one below, one at).
import { BREAKER, breaker, type RunVerdict } from '../src/repair';

const runs = (s: string): RunVerdict[] => s.split('').map((c) => (c === 'c' ? 'clean' : c === 'a' ? 'agent' : 'outcome_failed'));

describe('breaker', () => {
  it('failures in a row: 2 does not suspend, 3 does (default); the setting moves it', () => {
    expect(breaker(runs('cccccaa')).suspend).toBe(false);
    expect(breaker(runs('cccccaaa'))).toEqual({ suspend: true, reason: 'failures_in_a_row' });
    expect(breaker(runs('cccccaaa'), 4).suspend).toBe(false);
    expect(breaker(runs('ccccaaaa'), 4).reason).toBe('failures_in_a_row');
  });
  it('more than half of the last 10 needed the agent: 5 does not, 6 does', () => {
    expect(BREAKER.window).toBe(10);
    expect(breaker(runs('acacacacac')).suspend).toBe(false);
    expect(breaker(runs('acacacacaa'), 99)).toEqual({ suspend: true, reason: 'mostly_agent' });
    expect(breaker(runs('aaaaacacacccccc'), 99).suspend).toBe(false);
  });
  it('one failed outcome check after a clean history shorter than 3 suspends; after 3 clean runs it does not', () => {
    expect(breaker(runs('cco'))).toEqual({ suspend: true, reason: 'young_outcome_failure' });
    expect(breaker(runs('ccco')).suspend).toBe(false);
  });
  it('a clean history never suspends', () => {
    expect(breaker(runs('cccccccccccc'))).toEqual({ suspend: false, reason: null });
    expect(breaker([])).toEqual({ suspend: false, reason: null });
  });
});
