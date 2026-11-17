import { redactActionArgs } from '../tasks/redact';

/**
 * What a live run is doing right now (#379), stored in `runs.activity` and
 * streamed to the run page so a person sees the step in progress, not only
 * the steps that finished. Never secrets: arguments are redacted like a
 * step's.
 */
export type RunActivityPhase = 'starting' | 'looking' | 'thinking' | 'acting';

export interface RunActivity {
  phase: RunActivityPhase;
  /** The fabric action being run (`acting` only). */
  action?: string;
  /** Its arguments, redacted (`redactActionArgs`). */
  args?: Record<string, unknown>;
  /** Why the model chose it. */
  reason?: string;
  /** When this activity began (ISO 8601). */
  startedAt: string;
  /** How long the host has before the action times out. */
  timeoutMs?: number;
}

const REASON_CHARS = 500;

/** The activity for one phase, stamped now. `action` arguments are redacted. */
export function runActivity(
  phase: RunActivityPhase,
  opts: { action?: Record<string, unknown>; reason?: string; timeoutMs?: number } = {},
  now: Date = new Date(),
): RunActivity {
  const out: RunActivity = { phase, startedAt: now.toISOString() };
  if (opts.action) {
    const type = String(opts.action.type);
    out.action = type;
    out.args = redactActionArgs(type, opts.action);
  }
  if (opts.reason) out.reason = opts.reason.length > REASON_CHARS ? `${opts.reason.slice(0, REASON_CHARS)}…` : opts.reason;
  if (opts.timeoutMs !== undefined) out.timeoutMs = opts.timeoutMs;
  return out;
}
