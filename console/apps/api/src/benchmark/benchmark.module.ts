import { Module } from '@nestjs/common';

import { FabricModule } from '../fabric/fabric.module';
import { isSliceEnabled } from '../platform/slices/manifest';
import { PoliciesModule } from '../policies/policies.module';
import { QuestionsModule } from '../questions/questions.module';
import { TasksModule } from '../tasks/tasks.module';
import './benchmark.errors';
import './benchmark.settings';
import { BenchmarkGrader } from './benchmark-grader';
import { BenchmarkAdvanceHandler } from './benchmark.jobs';
import { BenchmarkMetrics } from './benchmark.metrics';
import { BenchmarkOwner } from './benchmark-owner';
import { BenchmarkQuestionListener } from './benchmark-question-listener';
import { BenchmarkRunStarter } from './benchmark-run-starter';
import { BenchmarkReportService } from './benchmark-report.service';
import { BenchmarkRunner } from './benchmark-runner.service';
import { BenchmarkSiteAddress } from './benchmark-site-address';
import { BenchmarksController } from './benchmarks.controller';
import { BenchmarksService } from './benchmarks.service';
import { ScorecardService } from './scorecard.service';
import { BenchmarkSiteController } from './site/site.controller';
import { BenchmarkSiteService } from './site/site.service';
import { TrialStateService } from './site/trial-state.service';

/**
 * A trial is a run, and a run needs the goal runner, which needs the AI slice (`packages/shared/slices.json`; app.module.ts mounts
 * `RunnerModule` the same way). Without it the challenge site is still served, and there is no route that starts a benchmark.
 */
const RUNS = isSliceEnabled('ai');

/**
 * Benchmarks (E44, epic #738; decision record `docs/decisions/benchmark.md`): the same challenges run under several agent policies on
 * a real node, each trial graded from the challenge site's own state.
 * - The foundation (#739): the tables (`prisma/fragments/benchmarks.prisma`), the permissions, the `benchmark` settings and the suite
 *   contract (`./suite/`).
 * - The challenge site (#740, `./site/`): the public pages of a trial, its token and its state.
 * - Running one (#741): `BenchmarksService` (start, read, cancel, delete) behind `/api/benchmarks`, the `benchmark.advance` job
 *   (`BenchmarkRunner`), the run starter, the scripted owner and the grader. It starts runs and answers questions through the same
 *   services everything else uses; it holds no agent logic.
 * - The scorecard (#742): `ScorecardService` (pure formulas in `scorecard.ts`, shapes in `scorecard.schemas.ts`) behind
 *   `/api/benchmarks/{id}/scorecard` and `/compare`, cached in `Benchmark.summary` when a benchmark ends.
 * - The report (#744): `BenchmarkReportService` behind `/api/benchmarks/{id}/export` (JSON, CSV, PDF), masked.
 */
@Module({
  imports: RUNS ? [FabricModule, TasksModule, QuestionsModule, PoliciesModule] : [],
  controllers: [BenchmarkSiteController, ...(RUNS ? [BenchmarksController] : [])],
  providers: [
    TrialStateService,
    BenchmarkSiteService,
    ...(RUNS ? [BenchmarkSiteAddress, BenchmarkMetrics, BenchmarkOwner, BenchmarkGrader, BenchmarkRunStarter, BenchmarkRunner, BenchmarkAdvanceHandler, BenchmarkQuestionListener, ScorecardService, BenchmarksService, BenchmarkReportService] : []),
  ],
  exports: [TrialStateService, ...(RUNS ? [BenchmarksService, ScorecardService, BenchmarkRunner, BenchmarkGrader] : [])],
})
export class BenchmarkModule {}
