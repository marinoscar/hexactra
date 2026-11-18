/**
 * How a run's steps read on its page (#380): repeated page reads fold into
 * one "observed the page" row, a failure that repeats is one row with a
 * count, and the list can run newest first.
 */

import type { Run } from '../types/runs';

/** `fetched`, plus any step of `prev` (received over the stream) it does not have yet. */
export function withStreamedSteps(fetched: Run, prev: Run | null): Run {
  if (!prev || prev.id !== fetched.id || !prev.steps?.length) return fetched;
  const have = new Set((fetched.steps ?? []).map((st) => st.seq));
  const extra = prev.steps.filter((st) => !have.has(st.seq));
  if (!extra.length) return fetched;
  const steps = [...(fetched.steps ?? []), ...extra].sort((a, b) => a.seq - b.seq);
  return { ...fetched, steps, stepCount: Math.max(fetched.stepCount, ...steps.map((st) => st.seq)) };
}

/** The fields of a run step the timeline reads. */
export interface TimelineStep {
  id: string;
  seq: number;
  kind: string;
  action: string | null;
  ok: boolean;
  summary: string;
  durationMs?: number | null;
  /** A step with a trace picture (#541) is never folded away with the page reads. */
  hasScreenshot?: boolean;
}

/** Steps that only look at the page (they change nothing). */
export const OBSERVATION_ACTIONS: ReadonlySet<string> = new Set(['text', 'elements', 'look', 'screenshot', 'tabs']);

export type TimelineOrder = 'newest' | 'oldest';

export type TimelineRow<S extends TimelineStep = TimelineStep> =
  /** One step, or (`steps.length > 1`) the same action failing several times in a row. */
  | { kind: 'step'; key: string; step: S; steps: S[] }
  /** Two or more successful observations in a row. */
  | { kind: 'observed'; key: string; steps: S[] };

export const isObservation = (s: TimelineStep) => s.ok && !s.hasScreenshot && s.action !== null && OBSERVATION_ACTIONS.has(s.action);

/** Group steps (any order in) into timeline rows, in `order`. */
export function groupSteps<S extends TimelineStep>(steps: readonly S[], order: TimelineOrder): TimelineRow<S>[] {
  const asc = [...steps].sort((a, b) => a.seq - b.seq);
  const rows: TimelineRow<S>[] = [];
  for (const s of asc) {
    const last = rows[rows.length - 1];
    if (isObservation(s) && last?.kind === 'observed') {
      last.steps.push(s);
      continue;
    }
    if (isObservation(s) && last?.kind === 'step' && last.steps.length === 1 && isObservation(last.step)) {
      // A second observation in a row: the single step becomes a group.
      rows[rows.length - 1] = { kind: 'observed', key: `obs-${last.step.seq}`, steps: [last.step, s] };
      continue;
    }
    if (!s.ok && last?.kind === 'step' && !last.step.ok && last.step.action === s.action) {
      last.steps.push(s);
      last.step = s;
      continue;
    }
    rows.push({ kind: 'step', key: `step-${s.seq}`, step: s, steps: [s] });
  }
  if (order === 'oldest') return rows;
  return rows.reverse().map((r) => ({ ...r, steps: [...r.steps].reverse() }));
}

/** "4.2 s", "850 ms", "1 min 5 s". */
export function formatStepDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}
