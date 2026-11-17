import { Module } from '@nestjs/common';

import { FabricModule } from '../fabric/fabric.module';
import { PoliciesModule } from '../policies/policies.module';

import { RunsController, TasksController } from './tasks.controller';
import { ActionTokenStore } from './action-token-store';
import { RunActionTokens } from './run-action-token';
import { RunMetrics } from './run-metrics';
import { RunNotifier } from './run-notifier';
import { RunRemindHandler, RunRemindTask, RunReminders } from './run-reminders';
import { RunsQueryService } from './runs.query';
import { TasksService } from './tasks.service';

/** Browser tasks and their runs (the goal runner lives in src/runner/). */
@Module({
  imports: [FabricModule, PoliciesModule],
  controllers: [TasksController, RunsController],
  providers: [TasksService, RunsQueryService, RunNotifier, RunMetrics, ActionTokenStore, RunActionTokens, RunReminders, RunRemindHandler, RunRemindTask],
  exports: [TasksService, RunsQueryService, RunNotifier, RunMetrics, ActionTokenStore, RunActionTokens, RunReminders],
})
export class TasksModule {}
