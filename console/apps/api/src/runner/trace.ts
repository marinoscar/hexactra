// The run trace (#541): what a run keeps so a person can follow it afterwards.
// Pure helpers: the key moments, the cap, the object key and the words of an
// answer step. No I/O.
import { maskSensitive } from '../tasks/mask';

/** The moments a masked screenshot is kept at. */
export const TRACE_MOMENTS = ['question', 'before_confirmed', 'after_confirmed', 'failure', 'final'] as const;
export type TraceMoment = (typeof TRACE_MOMENTS)[number];

/** The most images one run keeps; past it, only the confirmed-action pictures and the final screen. */
export const TRACE_MAX_IMAGES = 40;
/** The moments still kept past the cap. */
const KEPT_PAST_CAP: ReadonlySet<TraceMoment> = new Set(['before_confirmed', 'after_confirmed', 'final']);

/** Whether a moment gets a picture when the run already holds `taken` of them. */
export function traceAllowed(moment: TraceMoment, taken: number): boolean {
  return taken < TRACE_MAX_IMAGES || KEPT_PAST_CAP.has(moment);
}

/** The step kinds that are records, not actions (#541): they take a `seq`, never `stepCount` or the actions budget. */
export const NOTE_STEP_KINDS = ['routing', 'guidance', 'end', 'blocked'] as const;

/** A request whose answer is a secret: no picture is taken while it is open (#525), and its value is never in a step. */
export function isSecretInput(input: string | null | undefined): boolean {
  return input === 'secret' || input === 'credentials';
}

/** The moment of the picture taken as a person is asked: the screen they are asked about. */
export function questionMoment(kind: string): TraceMoment {
  return kind === 'confirmation' ? 'before_confirmed' : 'question';
}

/** The object key of a step's picture: `runs/<userId>/<runId>/<seq>-<moment>.jpg` (the `run-traces` prefix). */
export function traceKeyParts(runId: string, seq: number, moment: TraceMoment, contentType = 'image/jpeg'): [string, string] {
  return [runId, `${seq}-${moment}.${contentType === 'image/png' ? 'png' : 'jpg'}`];
}

export interface AnswerFacts {
  kind: string;
  input: string | null | undefined;
  /** The handoff reached `completed` with an answer. */
  completed: boolean;
  /** `completed`, `cancelled` (declined), `expired`, … */
  outcome: string | null | undefined;
  value?: string | null;
  values?: readonly string[] | null;
  /** The labels of the offered options, by value. */
  options?: readonly { id: string; label: string }[] | null;
  withheld?: boolean | null;
}

const MAX_ANSWER = 300;

/**
 * The summary of the step that records a person's answer (#541). A secret, a
 * sign-in or a withheld value never appears; anything else is masked.
 */
export function answerSummary(a: AnswerFacts): string {
  if (!a.completed) {
    if (a.outcome === 'cancelled' || a.outcome === 'declined') return a.kind === 'confirmation' ? 'The owner declined' : 'The owner declined to answer';
    return `The owner did not answer (${a.outcome ?? 'no answer'})`;
  }
  if (a.input === 'credentials') return 'The owner provided the sign-in';
  if (a.input === 'secret') return 'The owner provided it';
  if (a.kind === 'confirmation' || a.input === 'confirm' || a.input === 'none' || a.input === 'takeover') {
    if (a.input === 'confirm' && a.value && a.value !== 'approve') return 'The owner declined';
    if (a.input === 'takeover') return 'The owner took over and handed back';
    return a.kind === 'confirmation' || a.input === 'confirm' ? 'The owner allowed it' : 'The owner answered';
  }
  if (a.withheld) return 'The owner answered (value withheld)';
  const label = (v: string) => a.options?.find((o) => o.id === v)?.label ?? v;
  const raw = a.values?.length ? a.values.map(label).join(', ') : a.value ? label(a.value) : '';
  if (!raw) return 'The owner answered';
  const cut = raw.length > MAX_ANSWER ? `${raw.slice(0, MAX_ANSWER - 1)}…` : raw;
  return `The owner answered: ${maskSensitive(cut).text}`;
}

/** The summary of a `guidance` step: the owner's message, masked and cut. */
export function guidanceSummary(note: string): string {
  const flat = note.replace(/\s+/g, ' ').trim();
  const cut = flat.length > 1_000 ? `${flat.slice(0, 999)}…` : flat;
  return `The owner added: ${maskSensitive(cut).text}`;
}
