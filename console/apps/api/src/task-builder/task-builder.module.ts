import { Module } from '@nestjs/common';

import { ChatModule } from '../chat/chat.module';
import { AiModule } from '../platform/ai/ai.config';
import { PoliciesModule } from '../policies/policies.module';
import { TaskBuilderDraftService } from './task-builder-draft.service';
import { TaskBuilderController } from './task-builder.controller';
import { TaskBuilderService } from './task-builder.service';

/** The AI task builder (E42, #717). It needs the AI slice, through the chat module it builds on. */
@Module({
  imports: [AiModule, ChatModule, PoliciesModule],
  controllers: [TaskBuilderController],
  providers: [TaskBuilderService, TaskBuilderDraftService],
  exports: [TaskBuilderService, TaskBuilderDraftService],
})
export class TaskBuilderModule {}
