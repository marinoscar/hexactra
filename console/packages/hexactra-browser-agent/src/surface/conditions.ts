// Conditions (E46.14): wait for the page, not the clock. Before a browser step its element must resolve (exactly one confident match) and be
// visible and enabled; after it, its check must hold. Waits poll page queries through BrowserPort, end early on Stop or Pause, and time out
// from the step's own recorded durations (p95 × 3, clamped 2–30 s). A timeout is a failed check.
import type { BrowserPort } from '../browser-port';
import { abortableSleep } from './pacing';
import { pageElements, matchFingerprint, type ElementFingerprint, type Resolution } from './index';

export const READINESS = Object.freeze({ minMs: 2_000, maxMs: 30_000, defaultMs: 5_000, pollMs: 250 });

/** The readiness timeout of a step from its recorded durations: p95 × 3, clamped 2–30 s; the default without any. */
export function readinessTimeout(durationsMs: readonly number[]): number {
  if (durationsMs.length === 0) return READINESS.defaultMs;
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
  return Math.min(READINESS.maxMs, Math.max(READINESS.minMs, p95 * 3));
}

export interface WaitOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Injected for tests; the real one is `abortableSleep`. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
  now?: () => number;
}

export type Readiness = Resolution | { kind: 'aborted' } | { kind: 'timeout'; last: Resolution['kind'] };

/** Wait until the element resolves to one visible, enabled match; `ambiguous` ends the wait at once (waiting does not make it less so). */
export async function waitForElement(browser: BrowserPort, fp: ElementFingerprint, o: WaitOptions): Promise<Readiness> {
  const sleep = o.sleep ?? abortableSleep;
  const now = o.now ?? Date.now;
  const deadline = now() + o.timeoutMs;
  let last: Resolution = { kind: 'not_found' };
  for (;;) {
    if (o.signal?.aborted) return { kind: 'aborted' };
    const els = await pageElements(browser);
    const ready = (els ?? []).filter((e) => (e as { visible?: boolean }).visible !== false && (e as { enabled?: boolean }).enabled !== false);
    last = matchFingerprint(fp, ready);
    if (last.kind === 'found' || last.kind === 'ambiguous') return last;
    if (now() >= deadline) return { kind: 'timeout', last: last.kind };
    if (!(await sleep(Math.min(READINESS.pollMs, Math.max(0, deadline - now())), o.signal))) return { kind: 'aborted' };
  }
}

/** Wait until `holds()` is true (a postcondition), or the timeout. */
export async function waitUntil(holds: () => Promise<boolean>, o: WaitOptions): Promise<'held' | 'timeout' | 'aborted'> {
  const sleep = o.sleep ?? abortableSleep;
  const now = o.now ?? Date.now;
  const deadline = now() + o.timeoutMs;
  for (;;) {
    if (o.signal?.aborted) return 'aborted';
    if (await holds()) return 'held';
    if (now() >= deadline) return 'timeout';
    if (!(await sleep(Math.min(READINESS.pollMs, Math.max(0, deadline - now())), o.signal))) return 'aborted';
  }
}
