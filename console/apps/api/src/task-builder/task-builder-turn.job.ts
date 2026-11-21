import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AiError } from '@marinoscar/platform-api/ai';
import { JobHandlerRegistry, JobsService, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';

export { TaskBuilderTurnQueue } from './task-builder-turn.enqueue';
import { enqueueTaskBuilderTurn, TASK_BUILDER_TURN_JOB, TASK_BUILDER_TURN_MAX_RUNTIME_MS, TASK_BUILDER_TURN_MAX_WAITS, TASK_BUILDER_TURN_RETRY_DELAY_MS, type TaskBuilderTurnPayload } from './task-builder-turn.enqueue';
import { TaskBuilderTurnService } from './task-builder-turn.service';

/**
 * `task_builder.turn`: one turn of a task builder (E42.3). Server-only (the AI slice, the user's key path). One
 * attempt: a failure is written into the thread. A builder busy with another turn re-queues itself.
 */
@Injectable()
export class TaskBuilderTurnHandler implements JobHandler, OnModuleInit {
  readonly type = TASK_BUILDER_TURN_JOB;
  readonly label = 'Answer a task builder message';
  readonly profile = { maxRuntimeMs: TASK_BUILDER_TURN_MAX_RUNTIME_MS, maxAttempts: 1 };
  private readonly log = new Logger(TaskBuilderTurnHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly turns: TaskBuilderTurnService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const p = job.payload as unknown as TaskBuilderTurnPayload;
    const orgId = p.orgId ?? job.orgId ?? null;
    try {
      const outcome = await this.turns.run(p.conversationId, p.userId, orgId);
      this.log.log(`job ${job.id}: task builder ${p.conversationId} ${outcome}`);
      if (outcome !== 'busy') return;
      const waits = (p.waits ?? 0) + 1;
      if (waits > TASK_BUILDER_TURN_MAX_WAITS) return void this.log.warn(`job ${job.id}: task builder ${p.conversationId} stayed busy; giving up`);
      await enqueueTaskBuilderTurn(this.jobs, { conversationId: p.conversationId, userId: p.userId, orgId, waits }, 'task_builder_turn_busy', TASK_BUILDER_TURN_RETRY_DELAY_MS);
    } catch (e) {
      if (e instanceof AiError) throw e.toRateLimitError() ?? e;
      throw e;
    }
  }
}
