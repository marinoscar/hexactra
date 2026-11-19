import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EVENT_BUS, type EventBus } from '@marinoscar/platform-api/host';

/** The bus channel every run event goes on (cross-replica with the postgres bus). */
export const RUN_EVENTS_CHANNEL = 'runs.events';

/**
 * What happened to a run: its status changed, it recorded a step, or its owner pressed Stop (`run.cancel`, E38.1:
 * the worker that holds the run aborts its work at once; every other subscriber ignores it) or Pause (`run.pause`, E38.2:
 * the same worker ends its chunk before the next action and pauses the run).
 */
export const RUN_EVENT_TYPES = ['run.status', 'run.step', 'run.cancel', 'run.pause'] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

/**
 * One run event (#463). Ids and counters only, never page text, a result or
 * an answer: a subscriber that wants more re-reads the run as its owner
 * (`run_wait` reads it through the REST API).
 */
export interface RunEvent {
  type: RunEventType;
  runId: string;
  ownerUserId: string;
  /** `run.status`: the new status. */
  status?: string;
  /** `run.step`: the step count after the step. */
  stepCount?: number;
}

export type RunEventHandler = (e: RunEvent) => void | Promise<void>;

/**
 * The run's wake-up signal: the runner and the external browser sessions
 * `publish` after a status change or a recorded step has been written;
 * `subscribe` hears every replica's events (MCP `run_wait`). Rides the
 * platform's `EVENT_BUS` (one LISTEN connection per process, whatever the
 * number of subscribers); without one (a bare test module) it is in-process.
 * Publishing never fails the caller: a lost event only delays a waiter
 * until its deadline.
 */
@Injectable()
export class RunEvents {
  private readonly log = new Logger(RunEvents.name);
  private readonly local = new Set<RunEventHandler>();

  constructor(@Optional() @Inject(EVENT_BUS) private readonly bus?: EventBus) {}

  async publish(e: RunEvent): Promise<void> {
    if (this.bus) {
      try {
        await this.bus.publish(RUN_EVENTS_CHANNEL, e);
      } catch (err) {
        this.log.warn(`publish ${e.type} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    for (const h of [...this.local]) {
      try {
        await h(e);
      } catch (err) {
        this.log.warn(`handler for ${e.type} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Returns the unsubscribe function. A handler must not do I/O inline: it only wakes a waiter. */
  subscribe(handler: RunEventHandler): () => void {
    if (this.bus) return this.bus.subscribe<RunEvent>(RUN_EVENTS_CHANNEL, (e) => handler(e));
    this.local.add(handler);
    return () => void this.local.delete(handler);
  }
}
