import { Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { JobHandlerRegistry, JobsService, registerJobReason, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';
import { z } from 'zod';

import { randomUUID } from 'node:crypto';

import { checkOutcome } from '@marinoscar/hexactra-kgraph';

import { PrismaService } from '../prisma/prisma.service';
import { readStoredOutputs } from '../tasks/task-outputs.schemas';
import { KgraphCompileService } from './kgraph-compile.service';
import { declaredOutputs, readShapes } from './output-shapes';
import { PrismaProcedureStore } from './prisma-procedure-store';
import { KgraphSiteFactsService } from './site-facts.service';

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
    @Optional() private readonly siteFacts?: KgraphSiteFactsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const p = payloadSchema.parse(job.payload);
    const outcome = await this.compiler.compileRun(p.userId, p.runId);
    this.log.log(`job ${job.id}: run ${p.runId}: ${outcome}`);
    // Site fact proposals (E46.31) from the same learn- or reuse-mode run, whatever the compile did. Idempotent (one fact per identity) and
    // best effort: it never fails the job. Every proposal waits for the owner in Reviews.
    if (this.siteFacts) {
      const facts = await this.siteFacts.deriveForRun(p.userId, p.runId);
      if (facts.proposed > 0) this.log.log(`job ${job.id}: run ${p.runId}: ${facts.proposed} site fact proposal(s)`);
    }
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
    private readonly store: PrismaProcedureStore,
    @Optional() private readonly jobs?: JobsService,
  ) {}

  async finished(userId: string, runId: string, to: 'succeeded' | 'failed' | 'cancelled'): Promise<void> {
    await this.compareAudit(userId, runId, to);
    try {
      if (to !== 'succeeded' || !this.jobs) return;
      if ((await this.prisma.forUser({ userId }).kgTrace.count({ where: { runId, userId } })) === 0) return;
      await this.jobs.enqueue({ type: KGRAPH_COMPILE_JOB, reason: KGRAPH_COMPILE_REASON.id, subjectType: 'run', subjectId: runId, orgId: null, payload: { userId, runId } });
    } catch (err) {
      this.log.warn(`run ${runId}: kgraph after-run failed: ${err instanceof Error ? err.name : 'error'}`);
    }
  }

  /**
   * An audit run (E46.11) finished: its outputs' shapes are compared with what the procedure's verified runs produced. A disagreement on an
   * output records a failure on the version and a notice for the Knowledge Graph page. Never changes the run.
   */
  private async compareAudit(userId: string, runId: string, to: string): Promise<void> {
    try {
      if (to !== 'succeeded') return;
      const kg = await this.prisma.forUser({ userId }).kgRun.findFirst({ where: { runId, userId, aiOnly: true } });
      if (!kg?.procedureVersionId) return;
      const run = await this.prisma.forUser({ userId }).run.findFirst({ where: { id: runId, userId }, select: { outputs: true, outputsSpec: true } });
      const declared = declaredOutputs(run?.outputsSpec);
      if (!run || declared.length === 0) return;
      const stored = readStoredOutputs(run.outputs);
      const values = Object.fromEntries(Object.entries(stored).map(([k, v]) => [k, v.value]));
      const verdict = checkOutcome(declared, values, await readShapes(this.prisma, userId, kg.procedureVersionId));
      if (verdict.ok) return;
      await this.store.recordEvidence(userId, kg.procedureVersionId, null, 'failure', new Date().toISOString());
      await this.prisma.forUser({ userId }).kgNode.create({ data: { id: `kgn-${randomUUID()}`, userId, type: 'Notice', key: `audit:${runId}`, label: 'the AI-only run and the saved procedure disagree', props: { kind: 'audit_disagreement', runId, versionId: kg.procedureVersionId, problems: verdict.problems } } });
    } catch (err) {
      this.log.warn(`run ${runId}: kgraph audit comparison failed: ${err instanceof Error ? err.name : 'error'}`);
    }
  }
}
