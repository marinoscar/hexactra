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
import { RequestHistoryRetentionHandler, RequestHistoryRetentionTask } from './request-history.jobs';
import { TaskRunStarter } from './task-run-starter';
import { MemoryValueResolverService } from '../memories/memory-value.resolver';
import { MEMORY_VALUE_RESOLVER } from '../tasks/task-params';

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
    TaskRunStarter,
    // A task parameter's memory-backed default resolves from the owner's memories (#552, #551).
    { provide: MEMORY_VALUE_RESOLVER, useClass: MemoryValueResolverService },
    MemoryProposals,
    QuestionEvents,
    QuestionsExpireHandler,
    QuestionsExpireTask,
    RequestHistoryRetentionHandler,
    RequestHistoryRetentionTask,
    QuestionChannelRegistry,
    QuestionChannelDispatcher,
    QuestionsDeliverHandler,
    InboxQuestionChannel,
    NotificationsQuestionChannel,
    WebhookQuestionChannel,
  ],
  exports: [QuestionsService, TaskRunStarter, QuestionEvents, QuestionChannelRegistry, MemoryProposals],
})
export class QuestionsModule {}
