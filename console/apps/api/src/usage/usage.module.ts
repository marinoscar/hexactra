import { Module } from '@nestjs/common';

import { UsageRollupHandler, UsageRollupTask } from './usage-rollup.job';
import { UsageRollupService } from './usage-rollup.service';

/** AI usage and cost (epic #730): the hourly rollups (#732). */
@Module({
  providers: [UsageRollupService, UsageRollupHandler, UsageRollupTask],
  exports: [UsageRollupService],
})
export class UsageModule {}
