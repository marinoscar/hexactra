import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import { WebhooksService } from '@marinoscar/platform-api/webhooks';

import { RUN_FINISHED_EVENT, RUN_NEEDS_YOU_EVENT, SCHEDULE_FAILING_EVENT } from '../platform/notifications/hexactra.notifications';
import { RunActionTokens } from './run-action-token';
import { RUN_FINISHED_WEBHOOK, RUN_STARTED_WEBHOOK, RUN_WAITING_WEBHOOK, SCHEDULE_FAILING_WEBHOOK } from '../platform/webhooks/hexactra.webhook-events';

/** A run as the events describe it. */
export interface RunRef {
  id: string;
  goal: string;
  taskId?: string | null;
  trigger?: string;
}

/**
 * Tells a run's owner what happened, after the change committed. A no-op
 * without the notifications slice; a failure to notify never fails a run.
 * Payloads carry the goal, the agent's prompt and the result: never typed
 * text or secret values.
 */
@Injectable()
export class RunNotifier {
  private readonly log = new Logger(RunNotifier.name);

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly webhooks?: WebhooksService,
    @Optional() private readonly actions?: RunActionTokens,
  ) {}

  private async hook(event: string, userId: string, data: Record<string, unknown>): Promise<void> {
    if (!this.webhooks) return;
    try {
      await this.webhooks.emitForUser(userId, event, data);
    } catch (e) {
      this.log.warn(`webhook ${event} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private runData(run: RunRef, status: string) {
    return { runId: run.id, taskId: run.taskId ?? null, goal: run.goal.slice(0, 300), trigger: run.trigger ?? 'manual', status };
  }

  /** A run started. */
  async started(userId: string, run: RunRef): Promise<void> {
    await this.hook(RUN_STARTED_WEBHOOK, userId, this.runData(run, 'running'));
  }

  private url(path: string): string {
    return `${(this.config.get<string>('appUrl') ?? '').replace(/\/+$/, '')}${path}`;
  }

  private async send(event: string, userId: string, data: Record<string, unknown>): Promise<void> {
    if (!this.notifications) return;
    try {
      await this.notifications.notify(event, userId, data);
    } catch (e) {
      this.log.warn(`notify ${event} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async needsYou(userId: string, run: RunRef & { handoffId?: string | null }, prompt: string, kind: string, input = 'none'): Promise<void> {
    // The notification's buttons: Stop run always; Approve only for a plain confirmation.
    const approvable = kind === 'confirmation' && input === 'none' && Boolean(run.handoffId);
    const actionToken = this.actions?.issue(userId, run.id, approvable ? (run.handoffId ?? null) : null);
    await this.send(RUN_NEEDS_YOU_EVENT, userId, {
      runId: run.id,
      goal: run.goal.slice(0, 300),
      prompt: prompt.slice(0, 1000),
      kind,
      inboxUrl: this.url('/inbox'),
      ...(actionToken ? { actionToken, approvable } : {}),
    });
    await this.hook(RUN_WAITING_WEBHOOK, userId, { ...this.runData(run, 'waiting_human'), prompt: prompt.slice(0, 1000), kind });
  }

  async finished(userId: string, run: RunRef, status: string, result?: string | null): Promise<void> {
    await this.send(RUN_FINISHED_EVENT, userId, { runId: run.id, goal: run.goal.slice(0, 300), status, result: (result ?? '').slice(0, 500), runUrl: this.url(`/runs/${run.id}`) });
    await this.hook(RUN_FINISHED_WEBHOOK, userId, { ...this.runData(run, status), result: (result ?? '').slice(0, 2000) || null });
  }

  async scheduleFailing(userId: string, e: { scheduleId: string; taskName: string; failures: number }): Promise<void> {
    await this.send(SCHEDULE_FAILING_EVENT, userId, { ...e, tasksUrl: this.url('/tasks') });
    await this.hook(SCHEDULE_FAILING_WEBHOOK, userId, { scheduleId: e.scheduleId, taskName: e.taskName, failures: e.failures });
  }
}
