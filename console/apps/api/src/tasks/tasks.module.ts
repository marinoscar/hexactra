import { Module, type DynamicModule, type Provider } from '@nestjs/common';

import { FabricModule } from '../fabric/fabric.module';
import { PoliciesModule } from '../policies/policies.module';

import { isSliceEnabled } from '../platform/slices/manifest';
import { RunsController, TasksController } from './tasks.controller';
import { RunsDeleteController } from './run-delete.controller';
import { RunsDeleteHandler } from './run-delete.job';
import { RUN_ARTIFACT_STORE, RunDeleteService, type RunArtifactStore } from './run-delete.service';
import { ActionTokenStore } from './action-token-store';
import { RunRetentionController } from './run-retention.controller';
import { RunRetentionDoctorCheck } from './run-retention.doctor-check';
import { RunRetentionApplyHandler, RunRetentionHandler, RunRetentionTask } from './run-retention.job';
import { RunRetentionService } from './run-retention.service';
import { RunActionTokens } from './run-action-token';
import { RunMetrics } from './run-metrics';
import { RunNotifier } from './run-notifier';
import { RunRemindHandler, RunRemindTask, RunReminders } from './run-reminders';
import { RunsQueryService } from './runs.query';
import { TasksService } from './tasks.service';
import { TaskSchedulesController } from './task-schedules.controller';
import { TaskSchedulesService } from './task-schedules.service';
import { TaskSummaryService } from './task-summary.service';

/**
 * Where a deleted run's step screenshots are removed from: the storage slice's
 * provider, required only while that slice is enabled (an app without it has no
 * objects to remove, and `RunDeleteService` runs without the port).
 */
function runArtifactStore(): { imports: DynamicModule['imports']; providers: Provider[] } {
  if (!isSliceEnabled('storage')) return { imports: [], providers: [] };
  const storage = require('@marinoscar/platform-api/storage') as typeof import('@marinoscar/platform-api/storage');
  return {
    imports: [storage.StorageProvidersModule],
    providers: [
      {
        provide: RUN_ARTIFACT_STORE,
        useFactory: (provider: import('@marinoscar/platform-api/storage').StorageProvider): RunArtifactStore => ({ delete: (key) => provider.delete(key) }),
        inject: [storage.STORAGE_PROVIDER],
      },
    ],
  };
}
const artifacts = runArtifactStore();

/** Browser tasks and their runs (the goal runner lives in src/runner/). */
@Module({
  imports: [FabricModule, PoliciesModule, ...(artifacts.imports ?? [])],
  // RunsDeleteController and RunRetentionController first: their fixed paths are declared before any `:id` route.
  controllers: [TasksController, TaskSchedulesController, RunsDeleteController, RunRetentionController, RunsController],
  providers: [TasksService, RunsQueryService, RunDeleteService, RunsDeleteHandler, RunRetentionService, RunRetentionHandler, RunRetentionApplyHandler, RunRetentionTask, RunRetentionDoctorCheck, ...artifacts.providers, TaskSchedulesService, TaskSummaryService, RunNotifier, RunMetrics, ActionTokenStore, RunActionTokens, RunReminders, RunRemindHandler, RunRemindTask],
  exports: [TasksService, RunsQueryService, RunDeleteService, RunRetentionService, TaskSchedulesService, TaskSummaryService, RunNotifier, RunMetrics, ActionTokenStore, RunActionTokens, RunReminders],
})
export class TasksModule {}
