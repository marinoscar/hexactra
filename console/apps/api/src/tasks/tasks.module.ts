import { Module } from '@nestjs/common';

import { RunsController, TasksController } from './tasks.controller';
import { RunNotifier } from './run-notifier';
import { TasksService } from './tasks.service';

/** Browser tasks and their runs (the goal runner lives in src/runner/). */
@Module({
  controllers: [TasksController, RunsController],
  providers: [TasksService, RunNotifier],
  exports: [TasksService, RunNotifier],
})
export class TasksModule {}
