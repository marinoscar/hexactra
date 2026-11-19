import { redactActionArgs } from './redact';

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
  /** Where on the page it acts, in page screenshot (CSS viewport) pixels (#381). */
  target?: ActivityTarget;
  /** Why the run is on a stronger model, while it is: "Escalated to Frontier (stuck: repeated click on #submit)" (#405). */
  note?: string;
}

/** A point (a click, a hover) or a box (an element). */
export type ActivityTarget = { x: number; y: number; w?: number; h?: number };

/** An element box from the latest page screenshot's marks. */
export interface TargetMark {
  selector: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where an action acts on the page, when known: its coordinates, the start
 * of a drag, or the box of the element its selector names on the latest
 * marked screenshot. Desktop actions use screen coordinates, not the page's,
 * so they have none.
 */
export function actionTarget(action: Record<string, unknown>, marks: Iterable<TargetMark> = []): ActivityTarget | undefined {
  const type = String(action.type ?? '');
  if (type.startsWith('desktop_')) return undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const x = num(action.x);
  const y = num(action.y);
  if (x !== null && y !== null) return { x, y };
  const fx = num(action.from_x);
  const fy = num(action.from_y);
  if (fx !== null && fy !== null) return { x: fx, y: fy };
  if (typeof action.selector === 'string') {
    for (const m of marks) if (m.selector === action.selector) return { x: m.x, y: m.y, w: m.w, h: m.h };
  }
  return undefined;
}

const REASON_CHARS = 500;

/** The activity for one phase, stamped now. `action` arguments are redacted. */
export function runActivity(
  phase: RunActivityPhase,
  opts: { action?: Record<string, unknown>; reason?: string; timeoutMs?: number; target?: ActivityTarget; note?: string } = {},
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
  if (opts.target) out.target = opts.target;
  if (opts.note) out.note = opts.note.length > REASON_CHARS ? `${opts.note.slice(0, REASON_CHARS)}…` : opts.note;
  return out;
}
