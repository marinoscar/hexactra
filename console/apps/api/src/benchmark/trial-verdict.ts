// What a finished trial came to (E44.3, #741), as a plain function of how its run ended and what the grader said. No database.
import type { TrialFailureReason, TrialStatus, TrialVerdict } from './benchmark.constants';
import type { AskedQuestion, Check } from './suite/types';

export interface TrialOutcome {
  status: Extract<TrialStatus, 'graded' | 'skipped'>;
  verdict: TrialVerdict;
  failureReason: TrialFailureReason | null;
  checks: Check[] | null;
  claimedSuccess: boolean;
}

export interface TrialOutcomeInput {
  /** Why the benchmark itself stopped the run, written on the trial before the stop: `timeout`, `asked_person`, `stalled` or `cancelled`. */
  preset: string | null;
  run: { status: string; stopReason: string | null; error: string | null };
  /** The grader's checks, its error when it threw, or null when it was not run. */
  grade: { checks: Check[] } | { error: string } | null;
}

const MAX_CHECKS = 50;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const tidy = (checks: Check[]): Check[] =>
  checks.slice(0, MAX_CHECKS).map((c) => ({ name: clip(String(c.name), 100), pass: c.pass === true, ...(c.detail ? { detail: clip(String(c.detail), 500) } : {}) }));

/**
 * The verdict of a trial whose run has ended.
 * - The benchmark was cancelled, or somebody stopped the run: `skipped` (`cancelled`). It says nothing about the agent.
 * - The run could not work at all (no browser, no model, a provider error): `error`. Not the agent's failure.
 * - The grader threw or returned nothing: `error`, with its message.
 * - The trial timed out, the agent asked a question nobody scripted, or the run stalled and its policy asked a person to take over
 *   (`stalled`, #909): `fail`, whatever the site's state.
 * - Otherwise the checks decide: all pass is `pass`, even when the agent said it failed; anything else is `fail`, and the reason is
 *   the budget or the stall that stopped the run, else `wrong_result` (it claimed success) or `gave_up` (it did not).
 */
export function trialOutcome(i: TrialOutcomeInput): TrialOutcome {
  const claimedSuccess = i.run.status === 'succeeded';
  const checks = i.grade && 'checks' in i.grade ? tidy(i.grade.checks) : null;
  if (i.preset === 'cancelled') return { status: 'skipped', verdict: 'skipped', failureReason: 'cancelled', checks, claimedSuccess };
  if (!i.preset && i.run.status === 'failed' && (i.run.stopReason === 'error' || i.run.stopReason === 'no_model')) {
    return { status: 'graded', verdict: 'error', failureReason: i.run.stopReason === 'no_model' ? 'no_model' : 'error', checks: [{ name: 'run', pass: false, detail: clip(i.run.error || 'The run failed', 500) }], claimedSuccess };
  }
  if (!i.preset && i.run.status === 'cancelled') return { status: 'skipped', verdict: 'skipped', failureReason: 'cancelled', checks, claimedSuccess };
  if (!i.grade || 'error' in i.grade || !checks || checks.length === 0) {
    const why = i.grade && 'error' in i.grade ? i.grade.error : 'The grader returned no check';
    return { status: 'graded', verdict: 'error', failureReason: 'error', checks: [{ name: 'grader', pass: false, detail: clip(why, 500) }], claimedSuccess };
  }
  if (i.preset === 'timeout' || i.preset === 'asked_person' || i.preset === 'stalled') return { status: 'graded', verdict: 'fail', failureReason: i.preset, checks, claimedSuccess };
  if (checks.every((c) => c.pass)) return { status: 'graded', verdict: 'pass', failureReason: null, checks, claimedSuccess };
  const stop = i.run.stopReason ?? '';
  const failureReason: TrialFailureReason = stop.startsWith('budget_') ? 'budget' : stop === 'stalled' ? 'stalled' : claimedSuccess ? 'wrong_result' : 'gave_up';
  return { status: 'graded', verdict: 'fail', failureReason, checks, claimedSuccess };
}

/** The name of the check that keeps the question that ended a trial as "asked a person" (#884). */
export const ASKED_PERSON_CHECK = 'asked-person';
/** The name of the check that keeps the stall handoff that ended a trial as `stalled` (#909): its detail says what the agent repeated. */
export const STALL_HANDOFF_CHECK = 'stall-handoff';

/**
 * A trial that ended as `asked_person` keeps the question nobody scripted (#884): a failed check `asked-person` whose detail is
 * `<kind>: <masked prompt>`, so the trial list, the scorecard page, the reports and the CLI can show what the agent asked. The last
 * unanswered question is the one that ended it. A trial that ended as `stalled` through a stall handoff (#909) keeps it the same way,
 * as a failed check `stall-handoff`. Any other outcome is returned as it is.
 */
export function withAskedQuestion(outcome: TrialOutcome, asked: readonly AskedQuestion[], preset: string | null = 'asked_person'): TrialOutcome {
  const name = outcome.failureReason === 'asked_person' ? ASKED_PERSON_CHECK : outcome.failureReason === 'stalled' && preset === 'stalled' ? STALL_HANDOFF_CHECK : null;
  if (!name) return outcome;
  const q = [...asked].reverse().find((a) => a.answered === 'none');
  const detail = q ? clip(`${q.kind}: ${q.prompt.replace(/\s+/g, ' ').trim()}`, 500) : 'The question was not recorded';
  return { ...outcome, checks: [...(outcome.checks ?? []), { name, pass: false, detail }] };
}
