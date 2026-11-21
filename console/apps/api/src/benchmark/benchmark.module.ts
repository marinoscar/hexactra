import { Module } from '@nestjs/common';

import './benchmark.settings';

/**
 * Benchmarks (E44, epic #738; decision record `docs/decisions/benchmark.md`): the same challenges run under several agent policies on
 * a real node, each trial graded from the challenge site's own state. This module is the foundation only: the tables
 * (`prisma/fragments/benchmarks.prisma`), the permissions, the `benchmark` settings namespace and the suite contract (`./suite/`).
 * The challenge site (#740), the orchestration and the routes (#741) add their providers and controllers here.
 */
@Module({})
export class BenchmarkModule {}
