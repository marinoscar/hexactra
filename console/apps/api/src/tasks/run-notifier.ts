import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import { WebhooksService } from '@marinoscar/platform-api/webhooks';

import { RUN_FINISHED_EVENT, RUN_NEEDS_YOU_EVENT, RUN_REMINDER_EVENT, SCHEDULE_FAILING_EVENT, failingScheduleLink } from '../platform/notifications/hexactra.notifications';
import { RunActionTokens } from './run-action-token';
import { FINAL_WINDOW_MS, canSnooze } from './reminder-schedule';
import { RUN_FINISHED_WEBHOOK, RUN_STARTED_WEBHOOK, RUN_WAITING_WEBHOOK, SCHEDULE_FAILING_WEBHOOK } from '../platform/webhooks/hexactra.webhook-events';

/** A run as the events describe it. */
export interface RunRef {
  id: string;
  goal: string;
  taskId?: string | null;
  trigger?: string;
  /** The chat that started the run (#488): its notifications lead to the chat, where its requests are answered. */
  conversationId?: string | null;
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

  /**
   * Where the notification leads, as the data the templates read: a run a chat
   * started (#488) leads to its chat, where its requests are answered and its
   * result is; any other run to `path`. `key` is the URL the email template uses.
   */
  private at(run: RunRef, path: string, key: 'inboxUrl' | 'runUrl'): Record<string, string> {
    return run.conversationId ? { conversationId: run.conversationId, [key]: this.url(`/chat/${run.conversationId}`) } : { [key]: this.url(path) };
  }

  private async send(event: string, userId: string, data: Record<string, unknown>): Promise<void> {
    if (!this.notifications) return;
    try {
      await this.notifications.notify(event, userId, data);
    } catch (e) {
      this.log.warn(`notify ${event} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** The buttons' token and flags: Approve for a plain confirmation; Remind me in 15 min while there is time for it. */
  private buttons(userId: string, run: RunRef & { handoffId?: string | null }, kind: string, input: string, snoozable: boolean) {
    const approvable = kind === 'confirmation' && input === 'none' && Boolean(run.handoffId);
    const actionToken = this.actions?.issue(userId, run.id, approvable ? (run.handoffId ?? null) : null);
    return actionToken ? { actionToken, approvable, snoozable: !approvable && snoozable } : {};
  }

  async needsYou(userId: string, run: RunRef & { handoffId?: string | null }, prompt: string, kind: string, input = 'none', expiresAt: Date | null = null): Promise<void> {
    await this.send(RUN_NEEDS_YOU_EVENT, userId, {
      runId: run.id,
      goal: run.goal.slice(0, 300),
      prompt: prompt.slice(0, 1000),
      kind,
      ...this.at(run, '/inbox', 'inboxUrl'),
      ...this.buttons(userId, run, kind, input, canSnooze(expiresAt, new Date())),
    });
    await this.hook(RUN_WAITING_WEBHOOK, userId, { ...this.runData(run, 'waiting_human'), prompt: prompt.slice(0, 1000), kind });
  }

  /**
   * A request is still unanswered (run-reminders.ts): the same notification
   * again (same tag), with fresh buttons. No webhook: the request itself was
   * already announced.
   */
  async reminder(
    userId: string,
    run: RunRef & { handoffId?: string | null },
    ask: { prompt: string; kind: string; input: string },
    when: { expiresAt: Date | null; reminderCount: number; now: Date },
  ): Promise<void> {
    const left = when.expiresAt ? (when.expiresAt.getTime() - when.now.getTime()) / 60_000 : null;
    await this.send(RUN_REMINDER_EVENT, userId, {
      runId: run.id,
      goal: run.goal.slice(0, 300),
      prompt: ask.prompt.slice(0, 1000),
      kind: ask.kind,
      ...this.at(run, '/inbox', 'inboxUrl'),
      ...(left !== null ? { minutesLeft: Math.max(1, Math.round(left)), final: left * 60_000 <= FINAL_WINDOW_MS } : {}),
      ...this.buttons(userId, run, ask.kind, ask.input, canSnooze(when.expiresAt, when.now, when.reminderCount)),
    });
  }

  async finished(userId: string, run: RunRef, status: string, result?: string | null): Promise<void> {
    await this.send(RUN_FINISHED_EVENT, userId, { runId: run.id, goal: run.goal.slice(0, 300), status, result: (result ?? '').slice(0, 500), ...this.at(run, `/runs/${run.id}`, 'runUrl') });
    await this.hook(RUN_FINISHED_WEBHOOK, userId, { ...this.runData(run, status), result: (result ?? '').slice(0, 2000) || null });
  }

  /** The notice links to the task's schedules (`/tasks/:id#schedule`, #428), where the failing one carries a warning. */
  async scheduleFailing(userId: string, e: { scheduleId: string; taskId: string; taskName: string; failures: number }): Promise<void> {
    await this.send(SCHEDULE_FAILING_EVENT, userId, { ...e, tasksUrl: this.url(failingScheduleLink(e.taskId)) });
    await this.hook(SCHEDULE_FAILING_WEBHOOK, userId, { scheduleId: e.scheduleId, taskName: e.taskName, failures: e.failures });
  }
}
