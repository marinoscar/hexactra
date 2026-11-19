// The browser the tools drive, as a port (E38.5): the fabric session's operations the tools need, bound to the run's session. The browser
// layer never imports the fabric client; the host implements this over it.
import type { Screen, ScreenView, TraceShot } from './vision';

/** How long the browser has to carry out one action before the host times it out. */
export const ACTION_TIMEOUT_MS = 45_000;

/** An operation as the browser host reports it (the fields the tools read). */
export interface ActionOp {
  id: string;
  state: 'queued' | 'dispatched' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
  result?: Record<string, unknown>;
  error?: string;
  /** Top-level navigations the browser blocked under the session's allowed sites since the previous action (#508). */
  navigation_blocked?: Array<{ host: string; at: string }>;
}

/** The browser host refused or failed an action; the message is what the model reads after "Error:". */
export class BrowserError extends Error {}

/** Stop ended the wait for an action: the host finishes the action by itself, so its effect is not known. */
export class BrowserAborted extends BrowserError {}

/**
 * The run's browser session. Guarantees: `act` waits for the host's answer or the timeout; with `signal` aborted it throws
 * `BrowserAborted`; any other failure of the host is a `BrowserError`; `typeSecret` types a stored answer once and the value never
 * passes through this process; `capture` returns the model's screenshot, `captureTrace` the masked one (never unmasked).
 */
export interface BrowserPort {
  /** False while the run has no browser yet (it opens at the first call that needs one, E39.7). Absent: there is one. */
  hasSession?(): boolean;
  act(action: Record<string, unknown>, timeoutMs?: number, opts?: { signal?: AbortSignal; waitForTakeover?: boolean }): Promise<ActionOp>;
  typeSecret(opts: { handoffId: string; selector: string; clear?: boolean; submit?: boolean }): Promise<ActionOp>;
  capture(screen: Screen): Promise<ScreenView>;
  captureTrace(): Promise<TraceShot>;
}
