// E46.36 (#892): site facts derived after an everyday run (a chat or one-off run with `kgraph.everyday` on). The run's end queues one
// `kgraph.site_facts` job (KgraphAfterRun); the job reads the run's own server records (its step rows and the surface the everyday observer
// recorded), proposes facts (and applies the owner's opt-in auto-approve to the ones it covers), then removes the run's surface rows. It
// never compiles a procedure. Learn and reuse runs derive in the `kgraph.compile` job, as before.
import { Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { JobHandlerRegistry, registerJobReason, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';
import { z } from 'zod';

import { PrismaService } from '../prisma/prisma.service';
import { KgraphSiteFactsService } from './site-facts.service';

/** The job type that derives site facts after an everyday run. Permanent once jobs of this type exist: never rename it. */
export const KGRAPH_SITE_FACTS_JOB = 'kgraph.site_facts';
export const KGRAPH_SITE_FACTS_REASON = { id: 'kgraph_site_facts', label: 'Knowledge Graph: derive site facts from a chat or one-off run' } as const;
registerJobReason(KGRAPH_SITE_FACTS_REASON);

const payloadSchema = z.object({ userId: z.uuid(), runId: z.uuid() });

@Injectable()
export class KgraphSiteFactsHandler implements JobHandler, OnModuleInit {
  readonly type = KGRAPH_SITE_FACTS_JOB;
  readonly label = 'Derive Knowledge Graph site facts';
  readonly profile = { maxRuntimeMs: 2 * 60_000, maxAttempts: 3 };
  private readonly log = new Logger(KgraphSiteFactsHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    @Optional() private readonly siteFacts?: KgraphSiteFactsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** A succeeded everyday run is derived (idempotent: one fact per identity); any run's surface rows are then removed. Never throws for a fact. */
  async process(job: Job): Promise<void> {
    const p = payloadSchema.parse(job.payload);
    if (!this.siteFacts) return;
    const db = this.prisma.forUser({ userId: p.userId });
    const run = await db.run.findFirst({ where: { id: p.runId, userId: p.userId }, select: { status: true } });
    // Only a run the everyday observer marked: a run with the switch off has no `kg_runs` row and nothing is derived from it.
    const kg = await db.kgRun.findFirst({ where: { runId: p.runId, userId: p.userId }, select: { mode: true } });
    if (run?.status === 'succeeded' && kg?.mode === 'everyday') {
      const facts = await this.siteFacts.deriveAfterEverydayRun(p.userId, p.runId);
      if (facts.proposed > 0) this.log.log(`job ${job.id}: run ${p.runId}: ${facts.proposed} site fact proposal(s)`);
    }
    await this.siteFacts.dropRunSurface(p.userId, p.runId);
  }
}
