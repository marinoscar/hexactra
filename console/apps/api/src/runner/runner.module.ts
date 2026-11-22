import { Module } from '@nestjs/common';

import { ConnectionsModule } from '../connections/connections.module';
import { FabricModule } from '../fabric/fabric.module';
import { MemoriesModule } from '../memories/memories.module';
import { AiModule } from '../platform/ai/ai.config';
import { ApprovalsModule } from '../approvals/approvals.module';
import { PoliciesModule } from '../policies/policies.module';
import { QuestionsModule } from '../questions/questions.module';
import { isSliceEnabled } from '../platform/slices/manifest';
import { SecretsModule } from '../secrets/secrets.module';
import { TasksModule } from '../tasks/tasks.module';
import { GoalRunHandler, HandoffCheckHandler, HandoffCheckTask } from './goal-runner.jobs';
import { GoalRunnerService } from './goal-runner.service';
import { RunLiveController, RunOwnerGuard } from './run-live.controller';
import { RunsStartController } from './runs-start.controller';
import { KgraphModule } from '../kgraph/kgraph.module';

/**
 * The goal runner: an AI tool loop that drives a fabric browser toward a
 * run's goal, pausing for people through handoffs. It needs the AI slice
 * (its configured AiModule); the job queue is global.
 */
@Module({
  // The secrets module is mounted only with the credentials and notifications slices (app.module.ts): without it a run never signs in from a saved login.
  imports: [AiModule, FabricModule, TasksModule, QuestionsModule, PoliciesModule, MemoriesModule, ApprovalsModule, KgraphModule, ...(isSliceEnabled('credentials') && isSliceEnabled('notifications') ? [SecretsModule, ConnectionsModule] : [])],
  controllers: [RunsStartController, RunLiveController],
  providers: [RunOwnerGuard, GoalRunnerService, GoalRunHandler, HandoffCheckHandler, HandoffCheckTask],
  exports: [GoalRunnerService],
})
export class RunnerModule {}
