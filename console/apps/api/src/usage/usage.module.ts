import { Module } from '@nestjs/common';

import { UsageController } from './usage.controller';
import { UsagePricingService } from './usage-pricing.service';
import { UsageReportService } from './usage-report.service';
import { UsageRollupHandler, UsageRollupTask } from './usage-rollup.job';
import { UsageRollupService } from './usage-rollup.service';

/** AI usage and cost (epic #730): the hourly rollups (#732) and the report and CSV routes (#733). */
@Module({
  controllers: [UsageController],
  providers: [UsageRollupService, UsageRollupHandler, UsageRollupTask, UsagePricingService, UsageReportService],
  exports: [UsageRollupService, UsagePricingService, UsageReportService],
})
export class UsageModule {}
