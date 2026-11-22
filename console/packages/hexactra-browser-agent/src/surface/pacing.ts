// Pacing (E46.14): between replayed browser actions, a delay drawn from a bounded distribution, so a replay acts at a human pace. Pure and
// seeded for tests. This file and conditions.ts are the only replay code that waits; nothing else sleeps.

export type PacingMode = 'human' | 'fast';

export const PACING = Object.freeze({
  /** Between two browser actions. */
  action: { min: 400, max: 1500 },
  /** After a navigation. */
  afterNavigation: { min: 1200, max: 3000 },
});

/** A seeded random number generator (mulberry32): the same seed gives the same delays. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The delay before the next browser action, in ms. `fast` adds none (only readiness waits remain); never shorter than `readyMs`. */
export function pacingDelay(random: () => number, mode: PacingMode, afterNavigation: boolean, readyMs = 0): number {
  if (mode === 'fast') return 0;
  const { min, max } = afterNavigation ? PACING.afterNavigation : PACING.action;
  return Math.max(readyMs, Math.round(min + random() * (max - min)));
}

/** A wait that ends early, without throwing, when the signal aborts (Stop, Pause). Resolves true when it ran to the end. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(!signal?.aborted);
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
