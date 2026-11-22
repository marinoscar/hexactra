// The circuit breaker (E46.12): a procedure that keeps failing stops being used on its own. Pure, over the outcomes of the version's own runs,
// oldest first. All the thresholds are here.

/** How one run of a version ended: `clean` (replayed to the end and its checks passed), `agent` (handed over), `outcome_failed`. */
export type RunVerdict = 'clean' | 'agent' | 'outcome_failed';

export const BREAKER = Object.freeze({
  /** Default of `kgraph.suspendAfterFailures`: failures in a row that suspend. */
  failuresInARow: 3,
  /** The window of the "more than half needed the agent" rule. */
  window: 10,
  /** A failed outcome check suspends at once while the clean history is shorter than this. */
  youngHistory: 3,
});

export interface BreakerVerdict {
  suspend: boolean;
  reason: 'failures_in_a_row' | 'mostly_agent' | 'young_outcome_failure' | null;
}

export function breaker(history: readonly RunVerdict[], suspendAfterFailures: number = BREAKER.failuresInARow): BreakerVerdict {
  let trailing = 0;
  for (let i = history.length - 1; i >= 0 && history[i] !== 'clean'; i--) trailing++;
  if (suspendAfterFailures > 0 && trailing >= suspendAfterFailures) return { suspend: true, reason: 'failures_in_a_row' };
  const recent = history.slice(-BREAKER.window);
  if (recent.filter((h) => h !== 'clean').length * 2 > BREAKER.window) return { suspend: true, reason: 'mostly_agent' };
  const last = history[history.length - 1];
  if (last === 'outcome_failed' && history.slice(0, -1).filter((h) => h === 'clean').length < BREAKER.youngHistory) return { suspend: true, reason: 'young_outcome_failure' };
  return { suspend: false, reason: null };
}
