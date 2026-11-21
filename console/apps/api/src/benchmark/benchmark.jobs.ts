// The benchmark's job (E44.3, #741): `benchmark.advance` moves one benchmark forward by one pass. Everything long about a benchmark
// happens here, never in a request. The pass itself is `BenchmarkRunner.advance` (benchmark-runner.service.ts).
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { JobHandlerRegistry, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';

import { BENCHMARK_ADVANCE_JOB, type BenchmarkAdvancePayload } from './benchmark.jobs.enqueue';
import { BenchmarkRunner } from './benchmark-runner.service';

export * from './benchmark.jobs.enqueue';

/**
 * `benchmark.advance`: closes a trial that timed out, answers a trial's question from its challenge's rules, grades a trial whose run
 * ended, checks the spend cap, and starts the next trial or finishes the benchmark. Server-only. Safe to run twice and after a crash:
 * it reads the rows and every write is conditional on the state it read.
 */
@Injectable()
export class BenchmarkAdvanceHandler implements JobHandler, OnModuleInit {
  readonly type = BENCHMARK_ADVANCE_JOB;
  readonly label = 'Advance a benchmark';
  readonly profile = { maxRuntimeMs: 5 * 60_000, maxAttempts: 3 };
  private readonly log = new Logger(BenchmarkAdvanceHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly runner: BenchmarkRunner,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const p = job.payload as unknown as BenchmarkAdvancePayload;
    if (!p || typeof p.benchmarkId !== 'string') return;
    const outcome = await this.runner.advance(p.benchmarkId);
    this.log.log(`job ${job.id}: benchmark ${p.benchmarkId} ${outcome}`);
  }
}
