import { Injectable, type OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from '@marinoscar/platform-api/notifications';

import { QUESTION_ASKED_EVENT } from '../../platform/notifications/hexactra.notifications';
import { PrismaService } from '../../prisma/prisma.service';
import { QUESTION_ACTIONS, RunActionTokens } from '../../tasks/run-action-token';
import { isQuietRun } from '../../tasks/run-notifier';
import { isOwnerCardInput, type QuestionView } from '../questions.service';
import { quickAnswers } from './channel-rules';
import { QuestionChannelRegistry, type QuestionChannel, type QuestionChannelContext } from './question-channel';

/** The page of one question (the web app's `/inbox/q/:id`, also the Android app's). */
export function questionPath(id: string): string {
  return `/inbox/q/${encodeURIComponent(id)}`;
}

/**
 * `notifications`: the platform's notifications (in-app, Web Push, the
 * Android app, email) for a FREE-STANDING question, as `questions.asked`. A
 * question of a browser run is announced by `runs.needs_you` (the run
 * notifier) instead, so one question never makes two notifications.
 *
 * - The notification deep-links to the question. A low-risk confirm and a
 *   two-option choice get quick-answer buttons (a single-use signed token,
 *   `POST /api/notification-actions`); everything else opens the question.
 * - Withdraw: the in-app rows are dismissed. A push already shown on a
 *   device cannot be recalled without a second push; its buttons answer
 *   nothing (409) and the service worker opens the question instead.
 * - A no-op without the notifications slice.
 */
@Injectable()
export class NotificationsQuestionChannel implements QuestionChannel, OnModuleInit {
  readonly id = 'notifications';

  constructor(
    private readonly registry: QuestionChannelRegistry,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly tokens: RunActionTokens,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  canCollect(q: QuestionView): boolean {
    return quickAnswers(q) !== null;
  }

  /** What `questions.asked` carries for this question (never an answer). */
  payload(q: QuestionView, ownerUserId: string): Record<string, unknown> {
    const quick = quickAnswers(q);
    const actionToken = quick ? this.tokens.issueQuestion(ownerUserId, q.id, quick.map((a) => a.value), new Date(q.expiresAt)) : null;
    const base = (this.config.get<string>('appUrl') ?? '').replace(/\/+$/, '');
    return {
      questionId: q.id,
      prompt: (q.action ? q.action.summary : q.prompt).slice(0, 300),
      input: q.input,
      kind: q.kind,
      questionUrl: `${base}${questionPath(q.id)}`,
      ...(quick && actionToken ? { actionToken, quickActions: quick.map((a, i) => ({ action: QUESTION_ACTIONS[i], title: a.title })) } : {}),
    };
  }

  async deliver(q: QuestionView, ctx: QuestionChannelContext): Promise<void> {
    // A run's own requests are notified by the run (run-notifier.ts); a memory proposal (#553) and a "Save this login?" card (E37.4b) never pause their run, so they are notified here, without values.
    if (!this.notifications || (q.runId && !isOwnerCardInput(q.input))) return;
    // An owner card of a benchmark's trial run (#883): nobody reads it one by one, and the grader withdraws it.
    if (q.runId && isQuietRun(await this.prisma.run.findUnique({ where: { id: q.runId }, select: { trigger: true } }))) return;
    await this.notifications.notify(QUESTION_ASKED_EVENT, ctx.ownerUserId, this.payload(q, ctx.ownerUserId));
  }

  async withdraw(q: QuestionView, ctx: QuestionChannelContext): Promise<void> {
    if (q.runId && !isOwnerCardInput(q.input)) return;
    const now = new Date();
    await this.prisma.notification.updateMany({
      where: { userId: ctx.ownerUserId, eventKey: QUESTION_ASKED_EVENT, link: { startsWith: questionPath(q.id) }, dismissedAt: null },
      data: { dismissedAt: now, readAt: now },
    });
  }
}
