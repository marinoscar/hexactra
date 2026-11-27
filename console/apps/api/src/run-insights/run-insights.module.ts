import { Module } from '@nestjs/common';

import { RunInsightsController, TaskInsightsController } from './run-insights.controller';
import { RunInsightsService } from './run-insights.service';

/** Run findings and task consistency (E52.6, E52.7): computed on read from runs and their steps. No table, no model. */
@Module({
  controllers: [RunInsightsController, TaskInsightsController],
  providers: [RunInsightsService],
  exports: [RunInsightsService],
})
export class RunInsightsModule {}
