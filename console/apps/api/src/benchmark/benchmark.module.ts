import { Module } from '@nestjs/common';

import './benchmark.settings';
import { BenchmarkSiteController } from './site/site.controller';
import { BenchmarkSiteService } from './site/site.service';
import { TrialStateService } from './site/trial-state.service';

/**
 * Benchmarks (E44, epic #738; decision record `docs/decisions/benchmark.md`): the same challenges run under several agent policies on
 * a real node, each trial graded from the challenge site's own state. The foundation (#739) is the tables
 * (`prisma/fragments/benchmarks.prisma`), the permissions, the `benchmark` settings namespace and the suite contract (`./suite/`).
 * The challenge site (#740, `./site/`: the public pages of a trial, its token and its state) is here; the orchestration and the
 * routes (#741) add their providers and controllers, and use `TrialStateService` to open and close a trial's site.
 */
@Module({
  controllers: [BenchmarkSiteController],
  providers: [TrialStateService, BenchmarkSiteService],
  exports: [TrialStateService],
})
export class BenchmarkModule {}
