// One waiter's subscription to a run (#463): wakes on the run's status and
// step events and on its questions, from the in-process event source the
// runner publishes to (RunEvents, QuestionEvents on the platform EVENT_BUS).
// No database access: an idle waiter holds a handler in a Set, nothing else.
import type { RunWake, RunWatch } from './mcp.results';

/** A source of events for one run: subscribe returns the unsubscribe function. */
export type RunEventSource = (handler: (e: { runId: string | null; kind: 'status' | 'step' | 'question' }) => void) => () => void;

const RANK: Record<'status' | 'question' | 'step', number> = { status: 3, question: 2, step: 1 };

/**
 * Watch `runId` on every source. Events that arrive between two `next`
 * calls are kept (the strongest kind), so a change published while the
 * caller was reading the run is not lost. `signal` ends every wait with
 * `aborted` (the client went away). Throws when a source cannot subscribe:
 * the caller falls back to one read.
 */
export function watchRun(runId: string, sources: RunEventSource[], signal?: AbortSignal): RunWatch {
  let pending: 'status' | 'question' | 'step' | null = null;
  let wake: ((w: RunWake) => void) | null = null;
  let ignoreSteps = false;
  const offs: (() => void)[] = [];
  const onAbort = () => wake?.('aborted');
  try {
    for (const subscribe of sources) {
      offs.push(
        subscribe((e) => {
          if (e.runId !== runId) return;
          if (e.kind === 'step' && ignoreSteps) return;
          if (wake) wake(e.kind);
          else if (!pending || RANK[e.kind] > RANK[pending]) pending = e.kind;
        }),
      );
    }
  } catch (e) {
    for (const off of offs) off();
    throw e;
  }
  signal?.addEventListener('abort', onAbort);
  let closed = false;
  return {
    next(ms, opts = {}) {
      ignoreSteps = opts.ignoreSteps ?? false;
      if (signal?.aborted) return Promise.resolve('aborted');
      if (pending && !(pending === 'step' && ignoreSteps)) {
        const p = pending;
        pending = null;
        return Promise.resolve(p);
      }
      if (pending === 'step') pending = null;
      return new Promise<RunWake>((resolve) => {
        const timer = setTimeout(() => done('timeout'), Math.max(0, ms));
        const done = (w: RunWake) => {
          clearTimeout(timer);
          wake = null;
          resolve(w);
        };
        wake = done;
      });
    },
    close() {
      if (closed) return;
      closed = true;
      wake?.('aborted');
      signal?.removeEventListener('abort', onAbort);
      for (const off of offs) off();
    },
  };
}
