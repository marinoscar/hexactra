import { Injectable, Logger } from '@nestjs/common';

/** Called once a run has reached a terminal status and the write has committed. */
export type RunEndHook = (userId: string, runId: string) => Promise<void>;

/**
 * What else must happen when a run ends, registered by the modules that care
 * (the chat writes the run's result into its thread, #484). The two places a
 * run becomes terminal call `fire`: `TasksService.transition` and the goal run
 * job's failure path. A hook's failure is logged and never fails the run.
 */
@Injectable()
export class RunEndHooks {
  private readonly log = new Logger(RunEndHooks.name);
  private readonly hooks = new Set<RunEndHook>();

  /** Returns the function that removes the hook. */
  register(hook: RunEndHook): () => void {
    this.hooks.add(hook);
    return () => void this.hooks.delete(hook);
  }

  async fire(userId: string, runId: string): Promise<void> {
    for (const hook of [...this.hooks]) {
      try {
        await hook(userId, runId);
      } catch (e) {
        this.log.warn(`run ${runId}: an end hook failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}
