import { Module } from '@nestjs/common';

import { FabricModule } from '../fabric/fabric.module';
import { AiModule } from '../platform/ai/ai.config';
import { ApprovalsModule } from '../approvals/approvals.module';
import { PoliciesModule } from '../policies/policies.module';
import { QuestionsModule } from '../questions/questions.module';
import { TasksModule } from '../tasks/tasks.module';
import { GoalRunHandler, HandoffCheckHandler, HandoffCheckTask } from './goal-runner.jobs';
import { GoalRunnerService } from './goal-runner.service';
import { RunLiveController, RunOwnerGuard } from './run-live.controller';
import { RunsStartController } from './runs-start.controller';

/**
 * The goal runner: an AI tool loop that drives a fabric browser toward a
 * run's goal, pausing for people through handoffs. It needs the AI slice
 * (its configured AiModule); the job queue is global.
 */
@Module({
  imports: [AiModule, FabricModule, TasksModule, QuestionsModule, PoliciesModule, ApprovalsModule],
  controllers: [RunsStartController, RunLiveController],
  providers: [RunOwnerGuard, GoalRunnerService, GoalRunHandler, HandoffCheckHandler, HandoffCheckTask],
  exports: [GoalRunnerService],
})
export class RunnerModule {}
