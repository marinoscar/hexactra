// The version state machine (E46.10). Pure: a transition table, a check and a throwing guard. A store refuses any move the table does not
// allow (a conditional update on the current state).
import { z } from 'zod';

/**
 * `candidate` (compiled, never replayed) → `verified` (one clean replay) → `active` → `suspended` (circuit breaker) → `active` again on
 * restore, or `retired` (replaced, or pruned). `rejected`: failed validation; never runs.
 */
export const VERSION_STATES = ['candidate', 'verified', 'active', 'suspended', 'retired', 'rejected'] as const;
export const versionStateSchema = z.enum(VERSION_STATES);
export type VersionState = z.infer<typeof versionStateSchema>;

/** The state moves a host may make. Anything else is refused. */
export const VERSION_TRANSITIONS: Readonly<Record<VersionState, readonly VersionState[]>> = Object.freeze({
  candidate: ['verified', 'retired', 'rejected'],
  verified: ['active', 'suspended', 'retired'],
  active: ['suspended', 'retired'],
  suspended: ['active', 'retired'],
  retired: [],
  rejected: [],
});

export function canTransition(from: VersionState, to: VersionState): boolean {
  return VERSION_TRANSITIONS[from].includes(to);
}

export class IllegalTransition extends Error {
  constructor(
    readonly from: VersionState,
    readonly to: VersionState,
  ) {
    super(`a version cannot move from ${from} to ${to}`);
  }
}

/** Throws `IllegalTransition` for a move the table does not allow. */
export function assertTransition(from: VersionState, to: VersionState): void {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
}
