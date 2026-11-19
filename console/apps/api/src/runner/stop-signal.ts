import type { AiDefinedTool } from '@marinoscar/platform-api/ai';

import { maskSensitive } from '../tasks/mask';
import type { RunEvent } from '../tasks/run-events';

/** Thrown by `throwIfRequested`: the owner pressed Stop. */
export class RunStopRequested extends Error {
  constructor() {
    super('Stopped by the owner.');
    this.name = 'RunStopRequested';
  }
}

/** What the model reads when a tool is not carried out because the owner pressed Stop. */
export const STOPPED_TEXT = 'Stopped by the owner.';

/** How often the database flag is read while a job works (the guarantee when the API and the worker are not one process). */
export const STOP_POLL_MS = 1_000;

export interface RunStopSource {
  runId: string;
  /** Reads `runs.cancel_requested`. Errors are ignored: the next poll tries again. */
  isRequested: () => Promise<boolean>;
  /** `RunEvents.subscribe`: the fast path (`run.cancel`), cross-process with the postgres bus. */
  subscribe?: (handler: (e: RunEvent) => void) => () => void;
  pollMs?: number;
}

/**
 * The owner's Stop, as one signal per job (E38.1). It is fed by the `run.cancel` event the API publishes
 * when Stop is pressed (heard at once by the worker holding the run, whatever process it is in, when the event bus
 * spans processes) and by a poll of `runs.cancel_requested` every second (the guarantee when it does not, or
 * when an event is lost). `abortSignal` aborts the model call and the fabric wait in flight; `requested` is
 * what the runner checks before it does anything.
 */
export class RunStopSignal {
  private readonly controller = new AbortController();
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private disposed = false;

  private constructor(private readonly source: RunStopSource) {}

  /** Start listening and polling. Pair it with `dispose()` in a `finally`. */
  static start(source: RunStopSource): RunStopSignal {
    const signal = new RunStopSignal(source);
    signal.unsubscribe = source.subscribe?.((e) => {
      if (e.type === 'run.cancel' && e.runId === source.runId) signal.request();
    }) ?? null;
    signal.timer = setInterval(() => void signal.poll(), source.pollMs ?? STOP_POLL_MS);
    // A pending poll never keeps a process alive.
    signal.timer.unref?.();
    return signal;
  }

  get requested(): boolean {
    return this.controller.signal.aborted;
  }

  get abortSignal(): AbortSignal {
    return this.controller.signal;
  }

  throwIfRequested(): void {
    if (this.requested) throw new RunStopRequested();
  }

  /** Mark Stop as requested (also what the event and the poll do). Idempotent. */
  request(): void {
    if (!this.disposed && !this.controller.signal.aborted) this.controller.abort(new RunStopRequested());
  }

  /** One read of the database flag now. */
  async poll(): Promise<void> {
    if (this.polling || this.requested || this.disposed) return;
    this.polling = true;
    try {
      if (await this.source.isRequested()) this.request();
    } catch {
      // Best effort: the next poll tries again.
    } finally {
      this.polling = false;
    }
  }

  /** Stop listening and polling. A signal already requested stays requested. */
  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * The one seam around tool execution (E38.1): every tool is checked against the stop signal first. A tool the
 * model chose but that has not started when Stop is pressed is not carried out and records nothing: the model reads
 * `STOPPED_TEXT` and `onStopped` ends the chunk. Other wrappers around execution (a pause check, a
 * crash-safety marker) compose here, beside this one.
 */
export function stoppable(tools: readonly AiDefinedTool[], stop: Pick<RunStopSignal, 'requested'>, onStopped: () => void): AiDefinedTool[] {
  return tools.map((t) => ({
    ...t,
    execute: async (args, ctx) => {
      if (stop.requested) {
        onStopped();
        return STOPPED_TEXT;
      }
      return t.execute(args, ctx);
    },
  }));
}

/** The result of a run its owner stopped: what the last completed step was, masked. */
export function stoppedResult(log: readonly string[]): string {
  const last = [...log].reverse().find((l) => /^\d+\. /.test(l));
  if (!last) return 'Stopped by the owner before any step was completed.';
  return `Stopped by the owner. The last completed step was: ${maskSensitive(last.length > 400 ? `${last.slice(0, 399)}…` : last).text}`;
}

/** Resolve with `fallback` when `work` takes longer than `ms`: a slow extra never delays a Stop. */
export async function withinMs<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}
