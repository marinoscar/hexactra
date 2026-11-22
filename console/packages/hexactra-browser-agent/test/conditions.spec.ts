// E46.14 (#788): wait for the page, not the clock; act at a human pace.
import { abortableSleep, PACING, pacingDelay, readinessTimeout, seededRandom, waitForElement, type ElementFingerprint } from '../src/surface';
import { FakeBrowser } from '../src/testing';

const fp: ElementFingerprint = { role: 'button', name: 'Search', tag: 'button', inputType: null, selectors: ['#go'], anchor: null, frame: 'top' };
const go = { selector: '#go', selectors: ['#go'], role: 'button', name: 'Search', tag: 'button', inputType: null, anchor: null };

/** A virtual clock: each sleep advances it and runs what the page does at that time. */
function virtual(events: { at: number; run: () => void }[] = []) {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleeps,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) return false;
      sleeps.push(ms);
      t += ms;
      for (const e of events.filter((x) => x.at <= t)) {
        e.run();
        events.splice(events.indexOf(e), 1);
      }
      return !signal?.aborted;
    },
  };
}

describe('waitForElement', () => {
  it('a step whose element appears after 3 s succeeds', async () => {
    const browser = new FakeBrowser();
    const clock = virtual([{ at: 3000, run: () => browser.surface.push(go) }]);
    expect(await waitForElement(browser, fp, { timeoutMs: 10_000, ...clock })).toMatchObject({ kind: 'found', selector: '#go' });
    expect(clock.now()).toBe(3000);
  });
  it('one that never appears fails at the timeout', async () => {
    const clock = virtual();
    expect(await waitForElement(new FakeBrowser(), fp, { timeoutMs: 5_000, ...clock })).toEqual({ kind: 'timeout', last: 'not_found' });
    expect(clock.now()).toBe(5000);
  });
  it('an element that is there but disabled is not ready', async () => {
    const browser = new FakeBrowser();
    browser.surface = [{ ...go, enabled: false }];
    const clock = virtual([{ at: 1000, run: () => (browser.surface = [{ ...go, enabled: true }]) }]);
    expect(await waitForElement(browser, fp, { timeoutMs: 5_000, ...clock })).toMatchObject({ kind: 'found' });
    expect(clock.now()).toBe(1000);
  });
  it('Stop during a wait ends it at once', async () => {
    const stop = new AbortController();
    const clock = virtual([{ at: 500, run: () => stop.abort() }]);
    expect(await waitForElement(new FakeBrowser(), fp, { timeoutMs: 30_000, signal: stop.signal, ...clock })).toEqual({ kind: 'aborted' });
    expect(clock.now()).toBe(500);
  });
  it('the real sleep ends early on abort', async () => {
    const stop = new AbortController();
    const t = Date.now();
    setTimeout(() => stop.abort(), 20);
    expect(await abortableSleep(5_000, stop.signal)).toBe(false);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe('readinessTimeout', () => {
  it('is p95 × 3, clamped 2–30 s', () => {
    expect(readinessTimeout([])).toBe(5_000);
    expect(readinessTimeout([100, 200, 300])).toBe(2_000);
    expect(readinessTimeout([1000, 2000, 4000])).toBe(12_000);
    expect(readinessTimeout([20_000])).toBe(30_000);
  });
});

describe('pacing', () => {
  it('human gaps fall inside the bounds (seeded); after a navigation they are longer', () => {
    const r = seededRandom(42);
    const gaps = Array.from({ length: 200 }, () => pacingDelay(r, 'human', false));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(PACING.action.min);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(PACING.action.max);
    const nav = Array.from({ length: 50 }, () => pacingDelay(r, 'human', true));
    expect(Math.min(...nav)).toBeGreaterThanOrEqual(PACING.afterNavigation.min);
    expect(seededRandom(7)()).toBe(seededRandom(7)());
  });
  it('fast leaves only readiness waits', () => {
    expect(pacingDelay(seededRandom(1), 'fast', true)).toBe(0);
    expect(pacingDelay(seededRandom(1), 'human', false, 2000)).toBeGreaterThanOrEqual(2000);
  });
});
