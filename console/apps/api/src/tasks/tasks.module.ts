import { Module } from '@nestjs/common';

import { FabricModule } from '../fabric/fabric.module';

import { RunsController, TasksController } from './tasks.controller';
import { RunActionTokens } from './run-action-token';
import { RunMetrics } from './run-metrics';
import { RunNotifier } from './run-notifier';
import { RunRemindHandler, RunRemindTask, RunReminders } from './run-reminders';
import { TasksService } from './tasks.service';

/** Browser tasks and their runs (the goal runner lives in src/runner/). */
@Module({
  imports: [FabricModule],
  controllers: [TasksController, RunsController],
  providers: [TasksService, RunNotifier, RunMetrics, RunActionTokens, RunReminders, RunRemindHandler, RunRemindTask],
  exports: [TasksService, RunNotifier, RunMetrics, RunActionTokens, RunReminders],
})
export class TasksModule {}
