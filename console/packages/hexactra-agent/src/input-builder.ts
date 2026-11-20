// What the model reads each round (#406). The input is built so that the provider's prompt cache holds: the stable prefix (the goal,
// the owner's memories, the context, the progress log) comes first, in an order that never changes; what changes every round (the
// steps used, the owner's ask rules for the page) goes last, after the screenshots.
import { DEFAULT_FIRST_ROUND_HINT } from './tool-family';
import type { GateTarget } from './types';

export interface RoundText {
  goal: string;
  /** The memory block about the owner (#553), or ''. */
  aboutOwner: string;
  /** What an earlier job of the same chat did (#490), or undefined. */
  context?: string;
  /** Toolset lines of the stable prefix (for a browser: the allowed sites). */
  contextLines: string[];
  /** The run's log, oldest first. */
  log: readonly string[];
  /** How many log lines the model reads. */
  logLines: number;
  confirmedTarget?: GateTarget | null;
  /** Budget warnings queued for this round (#404). */
  warnings: readonly string[];
  /** The nudge a stall queued for this round. */
  nudge?: string;
  /** What the first round says after "Nothing has been done yet." (E41.2). Absent: the sentence every run read before tool families. */
  firstRoundHint?: string;
}

/** The round's text: the stable prefix and the lines that belong with it. Pure. */
export function buildRoundText(r: RoundText): string {
  return [
    `Goal: ${r.goal}`,
    r.aboutOwner,
    r.context ? `Earlier in this conversation (context only, already done):\n${r.context}` : '',
    ...r.contextLines,
    r.log.length ? `Progress so far (latest last):\n${r.log.slice(-r.logLines).join('\n')}` : `Nothing has been done yet. ${r.firstRoundHint ?? DEFAULT_FIRST_ROUND_HINT}`,
    r.confirmedTarget
      ? r.confirmedTarget.category
        ? `The person approved one step: pressing '${r.confirmedTarget.label ?? ''}' (${r.confirmedTarget.category}). Any other commitment needs its own confirmation.`
        : 'The person approved the next irreversible step.'
      : '',
    ...r.warnings,
    r.nudge ?? '',
    'Continue toward the goal.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The volatile tail, after the images: the steps used, and the owner's ask rules on this page when there are any (#555). */
export function buildStatus(input: { stepCount: number; actionsLimit: number | null; askLine: string | null }): string {
  const steps = `Steps used: ${input.stepCount}${input.actionsLimit !== null ? ` of ${input.actionsLimit}` : ' (no limit)'}.`;
  return input.askLine ? `${steps}\n${input.askLine}` : steps;
}
