import { Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { JobHandlerRegistry, JobsService, registerJobReason, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';
import { z } from 'zod';

import { PrismaService } from '../prisma/prisma.service';
import { KgraphCompileService } from './kgraph-compile.service';

/** The job type that compiles a run's trace (E46.7). Permanent once jobs of this type exist: never rename it. */
export const KGRAPH_COMPILE_JOB = 'kgraph.compile';
export const KGRAPH_COMPILE_REASON = { id: 'kgraph_compile', label: 'Knowledge Graph: compile a run into a procedure' } as const;
registerJobReason(KGRAPH_COMPILE_REASON);

const payloadSchema = z.object({ userId: z.uuid(), runId: z.uuid() });

/** `kgraph.compile`: one succeeded learn- or reuse-mode run's trace → a candidate procedure version. Idempotent per run. */
@Injectable()
export class KgraphCompileHandler implements JobHandler, OnModuleInit {
  readonly type = KGRAPH_COMPILE_JOB;
  readonly label = 'Compile a Knowledge Graph procedure';
  readonly profile = { maxRuntimeMs: 2 * 60_000, maxAttempts: 3 };
  private readonly log = new Logger(KgraphCompileHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly compiler: KgraphCompileService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const p = payloadSchema.parse(job.payload);
    const outcome = await this.compiler.compileRun(p.userId, p.runId);
    this.log.log(`job ${job.id}: run ${p.runId}: ${outcome}`);
  }
}

/**
 * What the runner calls when a run finished (E46.7). With the feature off the run has no trace rows and nothing is enqueued. A failure is
 * logged and never changes the run.
 */
@Injectable()
export class KgraphAfterRun {
  private readonly log = new Logger(KgraphAfterRun.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly jobs?: JobsService,
  ) {}

  async finished(userId: string, runId: string, to: 'succeeded' | 'failed' | 'cancelled'): Promise<void> {
    try {
      if (to !== 'succeeded' || !this.jobs) return;
      if ((await this.prisma.forUser({ userId }).kgTrace.count({ where: { runId, userId } })) === 0) return;
      await this.jobs.enqueue({ type: KGRAPH_COMPILE_JOB, reason: KGRAPH_COMPILE_REASON.id, subjectType: 'run', subjectId: runId, orgId: null, payload: { userId, runId } });
    } catch (err) {
      this.log.warn(`run ${runId}: kgraph after-run failed: ${err instanceof Error ? err.name : 'error'}`);
    }
  }
}
