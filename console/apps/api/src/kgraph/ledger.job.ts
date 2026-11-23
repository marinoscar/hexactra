import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { JobHandlerRegistry, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';

import { KGRAPH_LEDGER_JOB, type LedgerJobPayload } from './ledger.enqueue';
import { LedgerService } from './ledger.service';

/**
 * `kgraph.ledger.write` (E46.6, #780): writes the savings-ledger row of a run that ended with the Knowledge Graph on. Server-only; safe to
 * repeat. It reads the run after its final transition committed and never writes to the run: a failure here fails this job only.
 */
@Injectable()
export class LedgerWriteHandler implements JobHandler, OnModuleInit {
  readonly type = KGRAPH_LEDGER_JOB;
  readonly label = 'Write the Knowledge Graph savings ledger of a run';
  readonly profile = { maxRuntimeMs: 60_000, maxAttempts: 3 };
  private readonly log = new Logger(LedgerWriteHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly ledger: LedgerService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const p = job.payload as unknown as LedgerJobPayload;
    const r = await this.ledger.write(p.userId, p.runId);
    this.log.log(`job ${job.id}: run ${p.runId} ledger ${r}`);
  }
}
