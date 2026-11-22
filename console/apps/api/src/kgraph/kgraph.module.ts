import { Module } from '@nestjs/common';

import { KgraphAfterRun, KgraphCompileHandler } from './kgraph-compile.job';
import { KgraphCompileService } from './kgraph-compile.service';
import { KgraphEnabledService } from './kgraph-enabled.service';
import { KgraphController } from './kgraph.controller';
import { KgraphService } from './kgraph.service';
import { PrismaProcedureStore } from './prisma-procedure-store';
import { KgraphReviewsController } from './reviews.controller';
import { KgraphReviewsService } from './reviews.service';
import './kgraph.errors';
import { KgraphUpkeepDoctorCheck, KgraphUpkeepHandler, KgraphUpkeepTask } from './upkeep.job';
import { KgraphUpkeepService } from './upkeep.service';

/**
 * The Knowledge Graph host (epic E46, docs/decisions/knowledge-graph.md): the switches, the store binding and the routes. The runner asks
 * `KgraphEnabledService.modeFor` and nothing else whether a run uses it.
 */
@Module({
  controllers: [KgraphController, KgraphReviewsController],
  providers: [KgraphUpkeepService, KgraphUpkeepHandler, KgraphUpkeepTask, KgraphUpkeepDoctorCheck, KgraphReviewsService, KgraphEnabledService, KgraphService, PrismaProcedureStore, KgraphCompileService, KgraphCompileHandler, KgraphAfterRun],
  exports: [KgraphEnabledService, PrismaProcedureStore, KgraphAfterRun],
})
export class KgraphModule {}
