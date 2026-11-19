import { Module } from '@nestjs/common';

import { ConnectionsModule } from '../connections/connections.module';
import { QuestionsModule } from '../questions/questions.module';
import { TasksModule } from '../tasks/tasks.module';
import { MailTriggersController } from './mail-triggers.controller';
import { MailTriggerEvents } from './mail-triggers.events';
import { MailTriggersPollHandler, MailTriggersPollTask } from './mail-triggers.jobs';
import { MailTriggerLimitsService } from './mail-triggers.limits';
import { MailTriggerPoller } from './mail-trigger.poller';
import { MailTriggersService } from './mail-triggers.service';
import { MailTriggerUsage } from './mail-triggers.usage';

/**
 * Email triggers (E39.8, #605): start a task when a matching email arrives. Polls through the capability interfaces of Connections
 * and starts runs through the task starter. Mounted with Connections (app.module.ts).
 */
@Module({
  imports: [ConnectionsModule, TasksModule, QuestionsModule],
  controllers: [MailTriggersController],
  providers: [MailTriggerEvents, MailTriggerLimitsService, MailTriggerPoller, MailTriggersService, MailTriggersPollHandler, MailTriggersPollTask, MailTriggerUsage],
  exports: [MailTriggersService],
})
export class MailTriggersModule {}
