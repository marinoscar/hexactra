import { Module } from '@nestjs/common';

import { ChatModule } from '../chat/chat.module';
import { TaskBuilderController } from './task-builder.controller';
import { TaskBuilderService } from './task-builder.service';

/** The AI task builder (E42, #717). It needs the AI slice, through the chat module it builds on. */
@Module({
  imports: [ChatModule],
  controllers: [TaskBuilderController],
  providers: [TaskBuilderService],
  exports: [TaskBuilderService],
})
export class TaskBuilderModule {}
