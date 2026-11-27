import { Module } from '@nestjs/common';

import { AiModule } from '../platform/ai/ai.config';
import { TasksModule } from '../tasks/tasks.module';
import { TaskImproverController } from './task-improver.controller';
import { TaskImproverHandler } from './task-improver.job';
import { TaskImproverService } from './task-improver.service';

/** "Improve this task" (E52.8, #1023). It needs the AI slice. */
@Module({
  imports: [AiModule, TasksModule],
  controllers: [TaskImproverController],
  providers: [TaskImproverService, TaskImproverHandler],
  exports: [TaskImproverService],
})
export class TaskImproverModule {}
