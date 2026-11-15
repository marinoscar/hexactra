import { Module } from '@nestjs/common';

import { RunsController, TasksController } from './tasks.controller';
import { RunMetrics } from './run-metrics';
import { RunNotifier } from './run-notifier';
import { TasksService } from './tasks.service';

/** Browser tasks and their runs (the goal runner lives in src/runner/). */
@Module({
  controllers: [TasksController, RunsController],
  providers: [TasksService, RunNotifier, RunMetrics],
  exports: [TasksService, RunNotifier, RunMetrics],
})
export class TasksModule {}
