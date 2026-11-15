import { Module } from '@nestjs/common';

import { FabricModule } from '../fabric/fabric.module';
import { QuestionsModule } from '../questions/questions.module';
import { TasksModule } from '../tasks/tasks.module';
import { ExternalBrowserController } from './external-browser.controller';
import { HandoffAnswers } from './handoff-answers';
import { InboxController } from './inbox.controller';
import { NotificationActionsController } from './notification-actions.controller';

/**
 * Browsers driven through the console by external agents, and the inbox
 * where people answer every agent's handoffs. Needs no AI.
 */
@Module({
  imports: [FabricModule, TasksModule, QuestionsModule],
  controllers: [ExternalBrowserController, InboxController, NotificationActionsController],
  providers: [HandoffAnswers],
})
export class BrowserModule {}
