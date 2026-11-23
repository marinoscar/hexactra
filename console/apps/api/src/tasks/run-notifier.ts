import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import { WebhooksService } from '@marinoscar/platform-api/webhooks';

import { RUN_FINISHED_EVENT, RUN_NEEDS_YOU_EVENT, RUN_OVER_BUDGET_EVENT, RUN_REMINDER_EVENT, RUN_STILL_PAUSED_EVENT, RUN_CARD_AMOUNT_MISMATCH_EVENT, RUN_CARD_USED_EVENT, RUN_SAVED_APPROVALS_EVENT, RUN_SAVED_LOGIN_EVENT, SCHEDULE_FAILING_EVENT, KGRAPH_SUSPENDED_EVENT, failingScheduleLink } from '../platform/notifications/hexactra.notifications';
import { RunActionTokens } from './run-action-token';
import { RunReportLinks } from './run-report-link';
import { outputsView } from './task-outputs';
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
  /** The run's outputs as stored and the definitions it started with (E39.5): a finished run's webhook carries them, masked. */
  outputs?: unknown;
  outputsSpec?: unknown;
  /** Whether every output was returned and valid (E39.5); null for a run without outputs. */
  outputsComplete?: boolean | null;
}

/** The triggers whose runs never notify their owner (#883): a benchmark's trial runs. */
export const QUIET_RUN_TRIGGERS: readonly string[] = ['benchmark'];
/** Whether a run sends no notification: one a benchmark started. */
export const isQuietRun = (run: { trigger?: string | null } | null | undefined): boolean => !!run?.trigger && QUIET_RUN_TRIGGERS.includes(run.trigger);

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
    @Optional() private readonly reportLinks?: RunReportLinks,
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

  /**
   * A run event's notification, unless the run is a benchmark trial (#883): a benchmark starts dozens of runs on its own, and its owner
   * reads them on the benchmark's page, not one notification each. Webhooks are unchanged (they carry `trigger`).
   */
  private async sendFor(run: Pick<RunRef, 'trigger'>, event: string, userId: string, data: Record<string, unknown>): Promise<void> {
    if (isQuietRun(run)) return;
    await this.send(event, userId, data);
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
    await this.sendFor(run, RUN_NEEDS_YOU_EVENT, userId, {
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
    await this.sendFor(run, RUN_REMINDER_EVENT, userId, {
      runId: run.id,
      goal: run.goal.slice(0, 300),
      prompt: ask.prompt.slice(0, 1000),
      kind: ask.kind,
      ...this.at(run, '/inbox', 'inboxUrl'),
      ...(left !== null ? { minutesLeft: Math.max(1, Math.round(left)), final: left * 60_000 <= FINAL_WINDOW_MS } : {}),
      ...this.buttons(userId, run, ask.kind, ask.input, canSnooze(when.expiresAt, when.now, when.reminderCount)),
    });
  }

  /** A run has been paused for an hour (E38.2): once per pause. It leads to the chat or the run page, where it is resumed or stopped. No webhook. */
  async stillPaused(userId: string, run: RunRef): Promise<void> {
    await this.sendFor(run, RUN_STILL_PAUSED_EVENT, userId, { runId: run.id, goal: run.goal.slice(0, 300), ...this.at(run, `/runs/${run.id}`, 'runUrl') });
  }

  async finished(userId: string, run: RunRef, status: string, result?: string | null): Promise<void> {
    await this.sendFor(run, RUN_FINISHED_EVENT, userId, { runId: run.id, goal: run.goal.slice(0, 300), status, result: (result ?? '').slice(0, 500), ...this.at(run, `/runs/${run.id}`, 'runUrl') });
    // The outputs the run returned (E39.5), masked like every view: a sensitive value is `[hidden]`. Additive.
    const outputs = outputsView(run.outputsSpec, run.outputs);
    // Additive (E39.6): `outputsComplete`, the run's page, and a signed link to the masked PDF (7 days, this run only).
    await this.hook(RUN_FINISHED_WEBHOOK, userId, {
      ...this.runData(run, status),
      result: (result ?? '').slice(0, 2000) || null,
      ...(outputs ? { outputs, outputsComplete: run.outputsComplete ?? null } : {}),
      runUrl: this.url(run.conversationId ? `/chat/${run.conversationId}` : `/runs/${run.id}`),
      ...(this.reportLinks ? { reportUrl: this.reportLinks.url(userId, run.id) } : {}),
    });
  }

  /**
   * A chat run (#537) went over one of its usual limits and is still working:
   * once per run. It leads to the chat, where the owner can press Stop. No
   * webhook: nothing about the run's state changed.
   */
  /** A task's saved procedure was suspended by the circuit breaker (E46.12): once per suspension, with a link to the task. Names only. */
  async kgraphSuspended(userId: string, taskId: string, taskName: string, versionId: string): Promise<void> {
    await this.send(KGRAPH_SUSPENDED_EVENT, userId, { taskId, task: taskName.slice(0, 120), versionId, url: this.url(`/tasks/${taskId}`) });
  }

  async overBudget(userId: string, run: RunRef, usedOfLimit: string, label: string): Promise<void> {
    await this.sendFor(run, RUN_OVER_BUDGET_EVENT, userId, { runId: run.id, goal: run.goal.slice(0, 300), usedOfLimit, budget: label, ...this.at(run, `/runs/${run.id}`, 'runUrl') });
  }

  /**
   * Steps of a run went ahead on saved approvals (#555): once, at the end of the run, naming the rules
   * ("2 steps went ahead on saved approvals: Press 'Pay' on bankofamerica.com."), with a link to the run.
   * No webhook and no values: the summaries are the rules' own, written by the server.
   */
  async savedApprovalsUsed(userId: string, run: RunRef, line: string): Promise<void> {
    await this.sendFor(run, RUN_SAVED_APPROVALS_EVENT, userId, { runId: run.id, goal: run.goal.slice(0, 300), line: line.slice(0, 500), runUrl: this.url(`/runs/${run.id}`) });
  }

  /**
   * A scheduled run signed in with a saved login (E37.3): once per run, at its end, grouped ("Signed in to
   * shop.example.test with a saved login"). Sites only: never a login's name, username, password or code.
   */
  async savedLoginUsed(userId: string, run: RunRef, sites: string[]): Promise<void> {
    const shown = [...new Set(sites)].slice(0, 3);
    if (shown.length === 0) return;
    const more = new Set(sites).size - shown.length;
    const line = `Signed in to ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''} with a saved login`;
    await this.sendFor(run, RUN_SAVED_LOGIN_EVENT, userId, { runId: run.id, goal: run.goal.slice(0, 300), line, runUrl: this.url(`/runs/${run.id}`) });
  }

  /**
   * A saved card was typed at a shop (E37.7): one notification per use, attended or not ("Paid with Visa ending 4242 at
   * shop.example.test: 42.50 USD"). The brand, last four, host and the declared amount only; never a number, an expiry or a code.
   */
  async cardUsed(userId: string, run: RunRef, line: string): Promise<void> {
    await this.sendFor(run, RUN_CARD_USED_EVENT, userId, { runId: run.id, goal: run.goal.slice(0, 300), line: line.slice(0, 300), runUrl: this.url(`/runs/${run.id}`) });
  }

  /** The amount read on the confirmation page differs from the declared one (E37.7). */
  async cardAmountMismatch(userId: string, run: RunRef, line: string): Promise<void> {
    await this.sendFor(run, RUN_CARD_AMOUNT_MISMATCH_EVENT, userId, { runId: run.id, goal: run.goal.slice(0, 300), line: line.slice(0, 300), runUrl: this.url(`/runs/${run.id}`) });
  }

  /** The notice links to the task's schedules (`/tasks/:id#schedule`, #428), where the failing one carries a warning. */
  async scheduleFailing(userId: string, e: { scheduleId: string; taskId: string; taskName: string; failures: number }): Promise<void> {
    await this.send(SCHEDULE_FAILING_EVENT, userId, { ...e, tasksUrl: this.url(failingScheduleLink(e.taskId)) });
    await this.hook(SCHEDULE_FAILING_WEBHOOK, userId, { scheduleId: e.scheduleId, taskName: e.taskName, failures: e.failures });
  }
}
