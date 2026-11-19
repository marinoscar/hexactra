// The key moments of a run's trace (#541): when a masked picture is kept, and which requests never get one.

/** The moments a masked screenshot is kept at. */
export const TRACE_MOMENTS = ['question', 'before_confirmed', 'after_confirmed', 'failure', 'final'] as const;
export type TraceMoment = (typeof TRACE_MOMENTS)[number];

/** A request whose answer is a secret: no picture is taken while it is open (#525), and its value is never in a step. */
export function isSecretInput(input: string | null | undefined): boolean {
  return input === 'secret' || input === 'credentials';
}

/** The moment of the picture taken as a person is asked: the screen they are asked about. */
export function questionMoment(kind: string): TraceMoment {
  return kind === 'confirmation' ? 'before_confirmed' : 'question';
}
