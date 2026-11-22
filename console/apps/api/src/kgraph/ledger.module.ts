import { Module } from '@nestjs/common';

import { KgraphMetrics } from './kgraph-metrics';
import { KgraphLedgerController } from './ledger.controller';
import { LedgerWriteHandler } from './ledger.job';
import { LedgerService } from './ledger.service';

/**
 * The Knowledge Graph's savings ledger (E46.6, #780): the run-end hook, the `kgraph.ledger.write` job and the two read routes. Its own
 * module, mounted by the app beside `KgraphModule`, so the runner's imports (and the app's module order) stay as they were.
 */
@Module({
  controllers: [KgraphLedgerController],
  providers: [KgraphMetrics, LedgerService, LedgerWriteHandler],
  exports: [LedgerService],
})
export class KgraphLedgerModule {}
