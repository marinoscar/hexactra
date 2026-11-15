import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from '@marinoscar/platform-api/notifications';

import { RUN_FINISHED_EVENT, RUN_NEEDS_YOU_EVENT, SCHEDULE_FAILING_EVENT } from '../platform/notifications/hexactra.notifications';

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
  ) {}

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

  needsYou(userId: string, run: { id: string; goal: string }, prompt: string, kind: string): Promise<void> {
    return this.send(RUN_NEEDS_YOU_EVENT, userId, { runId: run.id, goal: run.goal.slice(0, 300), prompt: prompt.slice(0, 1000), kind, inboxUrl: this.url('/inbox') });
  }

  finished(userId: string, run: { id: string; goal: string }, status: string, result?: string | null): Promise<void> {
    return this.send(RUN_FINISHED_EVENT, userId, { runId: run.id, goal: run.goal.slice(0, 300), status, result: (result ?? '').slice(0, 500), runUrl: this.url(`/runs/${run.id}`) });
  }

  scheduleFailing(userId: string, e: { scheduleId: string; taskName: string; failures: number }): Promise<void> {
    return this.send(SCHEDULE_FAILING_EVENT, userId, { ...e, tasksUrl: this.url('/tasks') });
  }
}
