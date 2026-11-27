import { Module } from '@nestjs/common';

import { AdminRunStatsController, RunInsightsController, TaskInsightsController } from './run-insights.controller';
import { RunInsightsService } from './run-insights.service';
import { RunStatsService } from './run-stats.service';

/** Run findings, task consistency and run statistics (E52.6, E52.7, E53.1): computed on read from runs and their steps. No table, no model. */
@Module({
  controllers: [RunInsightsController, TaskInsightsController, AdminRunStatsController],
  providers: [RunInsightsService, RunStatsService],
  exports: [RunInsightsService, RunStatsService],
})
export class RunInsightsModule {}
