import { Module } from '@nestjs/common';

import { PoliciesModule } from '../policies/policies.module';
import { TasksModule } from '../tasks/tasks.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

/** Chats (#482): conversations and their messages. The AI turn lives in #484. */
@Module({
  imports: [TasksModule, PoliciesModule],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
