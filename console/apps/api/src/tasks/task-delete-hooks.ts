import { Injectable, Logger } from '@nestjs/common';

/** Called just before a task is deleted, with its id: what a module keeps outside the database rows that go with the task. */
export type TaskDeleteHook = (userId: string, taskId: string) => Promise<void>;

/**
 * What else must go when a task is deleted, registered by the modules that keep something the foreign keys cannot remove (deliveries:
 * the signing secrets of the task's webhooks, which live in the encrypted credential store). A hook's failure is logged and never
 * stops the delete.
 */
@Injectable()
export class TaskDeleteHooks {
  private readonly log = new Logger(TaskDeleteHooks.name);
  private readonly hooks = new Set<TaskDeleteHook>();

  /** Returns the function that removes the hook. */
  register(hook: TaskDeleteHook): () => void {
    this.hooks.add(hook);
    return () => void this.hooks.delete(hook);
  }

  async fire(userId: string, taskId: string): Promise<void> {
    for (const hook of [...this.hooks]) {
      try {
        await hook(userId, taskId);
      } catch (e) {
        this.log.warn(`task ${taskId}: a delete hook failed (${e instanceof Error ? e.name : 'error'})`);
      }
    }
  }
}
