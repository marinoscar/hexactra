import { Module } from '@nestjs/common';

import { FabricModule } from '../fabric/fabric.module';
import { QuestionEvents } from './question-events';
import { QuestionsController } from './questions.controller';
import { QuestionsExpireHandler, QuestionsExpireTask } from './questions.jobs';
import { QuestionsService } from './questions.service';

/**
 * The question broker (#288): questions agents ask people, answered from any
 * channel. Needs no AI; the goal runner, the external browser sessions and
 * the inbox use `QuestionsService`, channels subscribe to `QuestionEvents`.
 */
@Module({
  imports: [FabricModule],
  controllers: [QuestionsController],
  providers: [QuestionsService, QuestionEvents, QuestionsExpireHandler, QuestionsExpireTask],
  exports: [QuestionsService, QuestionEvents],
})
export class QuestionsModule {}
