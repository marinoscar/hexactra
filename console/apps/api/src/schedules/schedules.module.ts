import { Module } from '@nestjs/common';

import { TasksModule } from '../tasks/tasks.module';
import { SchedulesController } from './schedules.controller';
import { SchedulesTickHandler, SchedulesTickTask } from './schedules.jobs';
import { SchedulesService } from './schedules.service';

/** Task schedules: a per-minute tick starts due runs of the goal runner. */
@Module({
  imports: [TasksModule],
  controllers: [SchedulesController],
  providers: [SchedulesService, SchedulesTickHandler, SchedulesTickTask],
  exports: [SchedulesService],
})
export class SchedulesModule {}
