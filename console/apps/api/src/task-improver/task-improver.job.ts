import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { JobHandlerRegistry, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';

import { TASK_IMPROVER_JOB, TASK_IMPROVER_MAX_RUNTIME_MS, type TaskImproverPayload } from './task-improver.enqueue';
import { TaskImproverService } from './task-improver.service';

/**
 * `task_improver.propose`: makes one proposal (E52.8). Server-only (the AI slice, the owner's key path). One attempt: a failure is
 * stored on the proposal with a reason for a person; a job that dies leaves the row `running`, and the owner can ask again.
 */
@Injectable()
export class TaskImproverHandler implements JobHandler, OnModuleInit {
  readonly type = TASK_IMPROVER_JOB;
  readonly label = 'Propose a better goal for a task';
  readonly profile = { maxRuntimeMs: TASK_IMPROVER_MAX_RUNTIME_MS, maxAttempts: 1 };
  private readonly log = new Logger(TaskImproverHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly improver: TaskImproverService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const p = job.payload as unknown as TaskImproverPayload;
    const outcome = await this.improver.propose(p.improvementId, p.userId, p.orgId ?? job.orgId ?? null, job.id);
    this.log.log(`job ${job.id}: proposal ${p.improvementId} ${outcome}`);
  }
}
