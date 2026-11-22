import { Module } from '@nestjs/common';

import { KgraphEnabledService } from './kgraph-enabled.service';
import { KgraphController } from './kgraph.controller';
import { KgraphService } from './kgraph.service';
import { PrismaProcedureStore } from './prisma-procedure-store';
import './kgraph.errors';

/**
 * The Knowledge Graph host (epic E46, docs/decisions/knowledge-graph.md): the switches, the store binding and the routes. The runner asks
 * `KgraphEnabledService.modeFor` and nothing else whether a run uses it.
 */
@Module({
  controllers: [KgraphController],
  providers: [KgraphEnabledService, KgraphService, PrismaProcedureStore],
  exports: [KgraphEnabledService, PrismaProcedureStore],
})
export class KgraphModule {}
