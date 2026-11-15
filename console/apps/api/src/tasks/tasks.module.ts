import { Module } from '@nestjs/common';

import { RunsController, TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

/** Browser tasks and their runs (the goal runner lives in src/runner/). */
@Module({
  controllers: [TasksController, RunsController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
