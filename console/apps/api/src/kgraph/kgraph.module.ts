import { Module } from '@nestjs/common';

import { KgraphAfterRun, KgraphCompileHandler } from './kgraph-compile.job';
import { KgraphCompileService } from './kgraph-compile.service';
import { KgraphEnabledService } from './kgraph-enabled.service';
import { KgraphAdminController } from './kgraph-admin.controller';
import { KgraphAdminService } from './kgraph-admin.service';
import { KgraphReadController } from './kgraph-read.controller';
import { KgraphReadService } from './kgraph-read.service';
import { KgraphController } from './kgraph.controller';
import { KgraphService } from './kgraph.service';
import { PrismaProcedureStore } from './prisma-procedure-store';
import { KgraphReviewsController } from './reviews.controller';
import { KgraphReviewsService } from './reviews.service';
import { PrismaSiteFactStore } from './prisma-site-fact-store';
import { KgraphSiteFactReviewsController, KgraphSiteFactsController } from './site-facts.controller';
import { KgraphSiteFactsService } from './site-facts.service';
import { KgraphSiteFactsHandler } from './site-facts.job';
import { KgraphTransferController } from './transfer.controller';
import { KgraphTransferService } from './transfer.service';
import './kgraph.errors';
import { KgraphUpkeepDoctorCheck, KgraphUpkeepHandler, KgraphUpkeepTask } from './upkeep.job';
import { KgraphUpkeepService } from './upkeep.service';

/**
 * The Knowledge Graph host (epic E46, docs/decisions/knowledge-graph.md): the switches, the store binding and the routes. The runner asks
 * `KgraphEnabledService.modeFor` and nothing else whether a run uses it.
 */
@Module({
  controllers: [KgraphController, KgraphSiteFactReviewsController, KgraphReviewsController, KgraphSiteFactsController, KgraphReadController, KgraphAdminController, KgraphTransferController],
  providers: [KgraphTransferService, KgraphUpkeepService, KgraphUpkeepHandler, KgraphUpkeepTask, KgraphUpkeepDoctorCheck, KgraphReadService, KgraphAdminService, KgraphReviewsService, KgraphEnabledService, KgraphService, PrismaProcedureStore, KgraphCompileService, KgraphCompileHandler, KgraphAfterRun, PrismaSiteFactStore, KgraphSiteFactsService, KgraphSiteFactsHandler],
  exports: [KgraphEnabledService, PrismaProcedureStore, KgraphAfterRun, KgraphSiteFactsService],
})
export class KgraphModule {}
