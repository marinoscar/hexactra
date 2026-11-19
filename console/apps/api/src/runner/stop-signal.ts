import type { AiDefinedTool } from '@marinoscar/platform-api/ai';

import { maskSensitive } from '../tasks/mask';
import { stoppedResult as stoppedText } from './harness/outcome-text';
import { PAUSED_TEXT, STOPPED_TEXT } from './harness/types';
import { withinMs } from './harness/time';
import type { RunEvent } from '../tasks/run-events';

/** Thrown by `throwIfRequested`: the owner pressed Stop. */
export class RunStopRequested extends Error {
  constructor() {
    super('Stopped by the owner.');
    this.name = 'RunStopRequested';
  }
}

/** Thrown in place of a result when the owner paused the run. */
export class RunPauseRequested extends Error {
  constructor() {
    super('Paused by the owner.');
    this.name = 'RunPauseRequested';
  }
}

export { PAUSED_TEXT, STOPPED_TEXT };

/** How often the database flag is read while a job works (the guarantee when the API and the worker are not one process). */
export const STOP_POLL_MS = 1_000;

export interface RunStopSource {
  runId: string;
  /** Reads `runs.cancel_requested`. Errors are ignored: the next poll tries again. */
  isRequested: () => Promise<boolean>;
  /** Reads `runs.pause_requested` (E38.2). Absent: the signal never sees a pause. */
  isPauseRequested?: () => Promise<boolean>;
  /** `RunEvents.subscribe`: the fast path (`run.cancel`, `run.pause`), cross-process with the postgres bus. */
  subscribe?: (handler: (e: RunEvent) => void) => () => void;
  pollMs?: number;
}

/**
 * The owner's Stop, as one signal per job (E38.1). It is fed by the `run.cancel` event the API publishes
 * when Stop is pressed (heard at once by the worker holding the run, whatever process it is in, when the event bus
 * spans processes) and by a poll of `runs.cancel_requested` every second (the guarantee when it does not, or
 * when an event is lost). `abortSignal` aborts the model call and the fabric wait in flight; `requested` is
 * what the runner checks before it does anything.
 *
 * The same signal carries the owner's Pause (E38.2: the `run.pause` event and `runs.pause_requested`). A pause ends the chunk the
 * way Stop does, with two differences: it never aborts an action in flight (`abortSignal` is Stop's alone; the host finishes the
 * action and the run pauses after it), and a model call in flight is aborted through `haltSignal`, which either one trips.
 */
export class RunStopSignal {
  private readonly controller = new AbortController();
  private readonly halt = new AbortController();
  private paused = false;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<void> | null = null;
  private disposed = false;

  private constructor(private readonly source: RunStopSource) {}

  /** Start listening and polling. Pair it with `dispose()` in a `finally`. */
  static start(source: RunStopSource): RunStopSignal {
    const signal = new RunStopSignal(source);
    signal.unsubscribe = source.subscribe?.((e) => {
      if (e.runId !== source.runId) return;
      if (e.type === 'run.cancel') signal.request();
      else if (e.type === 'run.pause') signal.requestPause();
    }) ?? null;
    signal.timer = setInterval(() => void signal.poll(), source.pollMs ?? STOP_POLL_MS);
    // A pending poll never keeps a process alive.
    signal.timer.unref?.();
    return signal;
  }

  get requested(): boolean {
    return this.controller.signal.aborted;
  }

  /** Stop's own signal: aborts the fabric wait of an action in flight. A pause never trips it. */
  get abortSignal(): AbortSignal {
    return this.controller.signal;
  }

  /** The owner pressed Pause (E38.2) and Stop has not been pressed. */
  get pauseRequested(): boolean {
    return this.paused && !this.requested;
  }

  /** Aborts on Stop or on Pause: the model call in flight, which has done nothing yet that would need to finish. */
  get haltSignal(): AbortSignal {
    return this.halt.signal;
  }

  /** Stop or Pause: nothing more is started. */
  get halted(): boolean {
    return this.requested || this.paused;
  }

  throwIfRequested(): void {
    if (this.requested) throw new RunStopRequested();
  }

  /** Mark Stop as requested (also what the event and the poll do). Idempotent. */
  request(): void {
    if (this.disposed) return;
    if (!this.controller.signal.aborted) this.controller.abort(new RunStopRequested());
    if (!this.halt.signal.aborted) this.halt.abort(new RunStopRequested());
  }

  /** Mark Pause as requested (also what the event and the poll do). Idempotent. */
  requestPause(): void {
    if (this.disposed || this.paused) return;
    this.paused = true;
    if (!this.halt.signal.aborted) this.halt.abort(new RunPauseRequested());
  }

  /** One read of the database flag now. */
  poll(): Promise<void> {
    if (this.polling || this.requested || this.disposed) return this.polling ?? Promise.resolve();
    this.polling = (async () => {
      try {
        if (await this.source.isRequested()) this.request();
        else if (!this.paused && this.source.isPauseRequested && (await this.source.isPauseRequested())) this.requestPause();
      } catch {
        // Best effort: the next poll tries again.
      } finally {
        this.polling = null;
      }
    })();
    return this.polling;
  }

  /**
   * Stop listening and polling. A signal already requested stays requested. Resolves once a read already in
   * flight has finished, so nothing of the signal touches the database after the job's end.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.polling;
  }
}

/**
 * The one seam around tool execution (E38.1): every tool is checked against the stop signal first. A tool the
 * model chose but that has not started when Stop is pressed is not carried out and records nothing: the model reads
 * `STOPPED_TEXT` and `onStopped` ends the chunk. Other wrappers around execution (a pause check, a
 * crash-safety marker) compose here, beside this one.
 */
export function stoppable(
  tools: readonly AiDefinedTool[],
  stop: Pick<RunStopSignal, 'requested'> & Partial<Pick<RunStopSignal, 'pauseRequested'>>,
  onStopped: () => void,
  onPaused?: () => void,
): AiDefinedTool[] {
  return tools.map((t) => ({
    ...t,
    execute: async (args, ctx) => {
      if (stop.requested) {
        onStopped();
        return STOPPED_TEXT;
      }
      // The owner paused the run (E38.2): the same seam, a different word; the chunk ends and the run pauses.
      if (stop.pauseRequested && onPaused) {
        onPaused();
        return PAUSED_TEXT;
      }
      return t.execute(args, ctx);
    },
  }));
}

/** The result of a run its owner stopped: what the last completed step was, masked. */
export function stoppedResult(log: readonly string[]): string {
  return stoppedText(log, (l) => maskSensitive(l).text);
}

export { withinMs };
