// Wakes a benchmark when one of its trial runs asks a question (E44.3, #741). It only queues a pass: the scripted owner answers inside
// the `benchmark.advance` job, never in an event handler.
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { JobsService } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';
import { QuestionEvents } from '../questions/question-events';
import { readBenchmarkConfig } from './benchmark-config';
import { enqueueBenchmarkAdvance } from './benchmark.jobs.enqueue';

/** The run reaches `waiting_human` a moment after its question is recorded: the pass waits for that. */
export const QUESTION_PASS_DELAY_MS = 2_000;

@Injectable()
export class BenchmarkQuestionListener implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(BenchmarkQuestionListener.name);
  private off: (() => void) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly events: QuestionEvents,
  ) {}

  onModuleInit(): void {
    this.off = this.events.subscribe(async (e, meta) => {
      // Every replica hears the event: the one that recorded the question queues the pass.
      if (e.type !== 'question.asked' || !e.runId || !meta.local) return;
      try {
        await this.asked(e.runId);
      } catch (err) {
        this.log.warn(`run ${e.runId}: could not queue the benchmark pass: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  onModuleDestroy(): void {
    this.off?.();
  }

  /** Queues a pass for the benchmark whose running trial this run is; nothing for any other run. */
  async asked(runId: string): Promise<boolean> {
    const trial = await this.prisma.benchmarkTrial.findFirst({ where: { runId, status: 'running' }, select: { benchmarkId: true, benchmark: { select: { config: true } } } });
    if (!trial) return false;
    await enqueueBenchmarkAdvance(this.jobs, trial.benchmarkId, readBenchmarkConfig(trial.benchmark.config).orgId, 'benchmark_question', QUESTION_PASS_DELAY_MS);
    return true;
  }
}
