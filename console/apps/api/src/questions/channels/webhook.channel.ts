import { Injectable, type OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhooksService } from '@marinoscar/platform-api/webhooks';

import {
  QUESTION_ANSWERED_WEBHOOK,
  QUESTION_ASKED_WEBHOOK,
  QUESTION_CANCELLED_WEBHOOK,
  QUESTION_EXPIRED_WEBHOOK,
} from '../../platform/webhooks/hexactra.webhook-events';
import { ActionTokenStore } from '../../tasks/action-token-store';
import type { QuestionView } from '../questions.service';
import { isPublicAnswer } from './channel-rules';
import { QuestionChannelRegistry, type QuestionChannel, type QuestionChannelContext } from './question-channel';
import { holdsSecret } from '../questions.contract';

/** The header that carries a webhook answer token (never the query string). */
export const QUESTION_TOKEN_HEADER = 'x-question-token';

/** The `action_tokens.issue_key` of a question's webhook answer token: one per question. */
export const webhookIssueKey = (questionId: string) => `question-webhook:${questionId}`;

/**
 * `webhook`: the platform's outbound webhooks (`questions.question.*`), to
 * the endpoints the person registered. A public question (choice,
 * multi_choice, text, number, a low-risk confirm) carries a single-use answer
 * token, issued once per question and stored only as sha256, that answers it
 * through `POST /api/questions/:id/answer-by-token`. A secret, a takeover,
 * `none` and a high-risk confirm carry none: they are answered where the
 * console signs the person in. A no-op without the webhooks slice.
 */
@Injectable()
export class WebhookQuestionChannel implements QuestionChannel, OnModuleInit {
  readonly id = 'webhook';

  constructor(
    private readonly registry: QuestionChannelRegistry,
    private readonly config: ConfigService,
    private readonly tokens: ActionTokenStore,
    @Optional() private readonly webhooks?: WebhooksService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  canCollect(q: QuestionView): boolean {
    return isPublicAnswer(q);
  }

  private question(q: QuestionView) {
    return {
      id: q.id,
      // A call through a connection (E39.7): the card holds the details; a webhook receiver is told what it is, never the message or the cells.
      prompt: q.action ? q.action.summary : q.prompt,
      input: q.input,
      kind: q.kind,
      options: q.options,
      constraints: (q.constraints as Record<string, unknown> | null) ?? null,
      confirmLabel: q.confirmLabel,
      denyLabel: q.denyLabel,
      risk: q.risk,
      expiresAt: q.expiresAt,
      runId: q.runId,
    };
  }

  /**
   * The `questions.question.asked` data, issuing the answer token, or `null`
   * when it was built (and delivered) for this question already.
   */
  async askedPayload(q: QuestionView): Promise<Record<string, unknown> | null> {
    if (!this.canCollect(q)) return { question: this.question(q) };
    const token = await this.tokens.issue('question-webhook', { expiresAt: new Date(q.expiresAt), questionId: q.id, issueKey: webhookIssueKey(q.id) });
    if (!token) return null;
    const base = (this.config.get<string>('appUrl') ?? '').replace(/\/+$/, '');
    return {
      question: this.question(q),
      answer: { url: `${base}/api/questions/${q.id}/answer-by-token`, token, method: 'POST', tokenHeader: QUESTION_TOKEN_HEADER, expiresAt: q.expiresAt },
    };
  }

  /** The data of how a question ended. A secret or sign-in question never carries a value (not even a sign-in's username). */
  settledPayload(q: QuestionView): Record<string, unknown> {
    const r = q.response;
    const secret = holdsSecret(q.input);
    return {
      question: { id: q.id, input: q.input, kind: q.kind, runId: q.runId },
      status: q.status,
      ...(r
        ? {
            outcome: r.outcome,
            ...(!secret && r.value !== undefined ? { value: r.value } : {}),
            ...(!secret && r.values !== undefined ? { values: r.values } : {}),
            valueWithheld: secret ? r.outcome === 'completed' : r.valueWithheld,
            channel: r.channel ?? null,
            answeredAt: r.answeredAt,
          }
        : {}),
    };
  }

  async deliver(q: QuestionView, ctx: QuestionChannelContext): Promise<void> {
    if (!this.webhooks) return;
    const data = await this.askedPayload(q);
    if (data) await this.webhooks.emitForUser(ctx.ownerUserId, QUESTION_ASKED_WEBHOOK, data);
  }

  async withdraw(q: QuestionView, ctx: QuestionChannelContext): Promise<void> {
    if (!this.webhooks) return;
    const key = q.status === 'answered' ? QUESTION_ANSWERED_WEBHOOK : q.status === 'cancelled' ? QUESTION_CANCELLED_WEBHOOK : q.status === 'expired' ? QUESTION_EXPIRED_WEBHOOK : null;
    if (key) await this.webhooks.emitForUser(ctx.ownerUserId, key, this.settledPayload(q));
  }
}
