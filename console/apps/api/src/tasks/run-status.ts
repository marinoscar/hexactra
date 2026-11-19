import { ConflictException } from '@nestjs/common';

export type RunStatus = 'queued' | 'running' | 'waiting_human' | 'succeeded' | 'failed' | 'cancelled' | 'paused';

/**
 * The run state machine:
 *
 *   queued ─▶ running ─▶ succeeded | failed | cancelled
 *     │          │ ▲
 *     │          ▼ │
 *     │     waiting_human ─▶ failed | cancelled
 *     └──────────────────────▶ cancelled | failed
 *
 * A run the owner paused (E38.2) is live, not finished: it holds its browser session and its memory, and its time budget does
 * not run. running | waiting_human | queued ─▶ paused ─▶ queued (resumed) | cancelled | failed.
 *
 * A task run created waiting for its parameter values (#552) goes
 * waiting_human ─▶ queued once its form is answered.
 *
 * Terminal states never change again.
 */
export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ['running', 'cancelled', 'failed', 'paused'],
  running: ['waiting_human', 'succeeded', 'failed', 'cancelled', 'paused'],
  waiting_human: ['running', 'queued', 'failed', 'cancelled', 'paused'],
  paused: ['queued', 'cancelled', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

/** Every status in which a run is not finished (the `state=live` group). */
export const LIVE_STATUSES: readonly RunStatus[] = ['queued', 'running', 'waiting_human', 'paused'];

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled'];

export function isTerminal(s: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(s);
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictException({ code: 'INVALID_RUN_TRANSITION', message: `A run cannot go from ${from} to ${to}` });
  }
}
