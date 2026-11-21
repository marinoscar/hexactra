import { Module } from '@nestjs/common';

import { ChatModule } from '../chat/chat.module';
import { AiModule } from '../platform/ai/ai.config';
import { PoliciesModule } from '../policies/policies.module';
import { TasksModule } from '../tasks/tasks.module';
import { TaskBuilderDraftService } from './task-builder-draft.service';
import { TaskBuilderTurnQueue } from './task-builder-turn.enqueue';
import { TaskBuilderTurnHandler } from './task-builder-turn.job';
import { TaskBuilderTurnService } from './task-builder-turn.service';
import { TaskBuilderController } from './task-builder.controller';
import { TaskBuilderService } from './task-builder.service';

/** The AI task builder (E42, #717). It needs the AI slice, through the chat module it builds on. */
@Module({
  imports: [AiModule, ChatModule, PoliciesModule, TasksModule],
  controllers: [TaskBuilderController],
  providers: [TaskBuilderService, TaskBuilderDraftService, TaskBuilderTurnService, TaskBuilderTurnQueue, TaskBuilderTurnHandler],
  exports: [TaskBuilderService, TaskBuilderDraftService, TaskBuilderTurnService],
})
export class TaskBuilderModule {}
