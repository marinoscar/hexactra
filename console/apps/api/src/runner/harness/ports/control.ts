/**
 * The owner's Stop and Pause for one job (E38.1, E38.2). One signal per job, created when the job starts and disposed when it ends.
 * A correct implementation hears a Stop within about a second whatever process asked for it (an event, with a poll as the guarantee),
 * and never reports a Pause once a Stop is requested.
 */
export interface ControlPort {
  /** Stop was pressed. Checked before anything is done on the owner's behalf. */
  readonly requested: boolean;
  /** Pause was pressed and Stop was not. An action already sent is never aborted by a Pause. */
  readonly pauseRequested: boolean;
  /** Aborts only on Stop: the wait for an action in flight. */
  readonly abortSignal: AbortSignal;
  /** Aborts on Stop or Pause: the model call in flight, which has done nothing yet that would need to finish. */
  readonly haltSignal: AbortSignal;
  /** Reads the flags from the store now (the signal's poll may not have run yet). */
  readFlags(): Promise<{ cancelRequested: boolean; pauseRequested: boolean }>;
}
