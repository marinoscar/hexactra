import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module';
import { FabricModule } from '../fabric/fabric.module';
import { MemoriesModule } from '../memories/memories.module';
import { MemoryProposals } from '../memories/memory-proposals.service';
import { TasksModule } from '../tasks/tasks.module';
import { AnswerByTokenController } from './channels/answer-by-token.controller';
import { InboxQuestionChannel } from './channels/inbox.channel';
import { NotificationsQuestionChannel } from './channels/notifications.channel';
import { QuestionChannelRegistry } from './channels/question-channel';
import { QuestionChannelDispatcher, QuestionsDeliverHandler } from './channels/question-dispatcher';
import { WebhookQuestionChannel } from './channels/webhook.channel';
import { QuestionEvents } from './question-events';
import { QuestionsController } from './questions.controller';
import { QuestionsExpireHandler, QuestionsExpireTask } from './questions.jobs';
import { QuestionsService } from './questions.service';

/**
 * The question broker (#288): questions agents ask people, answered from any
 * channel. Needs no AI; the goal runner, the external browser sessions and
 * the inbox use `QuestionsService`. The channels (#289: the inbox, the
 * platform's notifications, webhooks, and any a feature registers in
 * `QuestionChannelRegistry`) hear `QuestionEvents` through the dispatcher.
 */
@Module({
  imports: [FabricModule, TasksModule, MemoriesModule, ApprovalsModule],
  controllers: [QuestionsController, AnswerByTokenController],
  providers: [
    QuestionsService,
    MemoryProposals,
    QuestionEvents,
    QuestionsExpireHandler,
    QuestionsExpireTask,
    QuestionChannelRegistry,
    QuestionChannelDispatcher,
    QuestionsDeliverHandler,
    InboxQuestionChannel,
    NotificationsQuestionChannel,
    WebhookQuestionChannel,
  ],
  exports: [QuestionsService, QuestionEvents, QuestionChannelRegistry, MemoryProposals],
})
export class QuestionsModule {}
