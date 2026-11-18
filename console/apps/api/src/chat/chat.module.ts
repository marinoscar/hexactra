import { Module } from '@nestjs/common';

import { AiModule } from '../platform/ai/ai.config';
import { PoliciesModule } from '../policies/policies.module';
import { TasksModule } from '../tasks/tasks.module';
import { ChatOwnerGuard, ChatStreamController, ChatStreamService } from './chat-stream.controller';
import { ChatResults } from './chat-results.service';
import { ChatTurnHandler, ChatTurnQueue } from './chat-turn.job';
import { ChatTurnService } from './chat-turn.service';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

/**
 * Chats (#482): conversations and their messages, and the turn engine that
 * answers a message or starts a browser run for it (#484). It needs the AI
 * slice (its configured AiModule); the job queue is global.
 */
@Module({
  imports: [AiModule, TasksModule, PoliciesModule],
  // ChatStreamController first: its fixed `:id/stream` path is declared before the `:id` routes.
  controllers: [ChatStreamController, ChatController],
  providers: [ChatOwnerGuard, ChatStreamService, ChatService, ChatResults, ChatTurnService, ChatTurnQueue, ChatTurnHandler],
  exports: [ChatService, ChatTurnService, ChatResults],
})
export class ChatModule {}
