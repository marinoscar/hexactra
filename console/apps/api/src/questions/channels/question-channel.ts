import { Injectable } from '@nestjs/common';

import type { QuestionEventType } from '../question-events';
import type { QuestionView } from '../questions.service';

/** Why a channel is told to deliver or withdraw. */
export interface QuestionChannelContext {
  /** The person the question is asked of. */
  ownerUserId: string;
  /** The event that caused it (`question.asked` for a delivery). */
  event: QuestionEventType;
  /** The channel that answered or declined, on `question.answered` / `question.cancelled`. */
  answeredChannel: string | null;
}

/**
 * A place a question reaches a person (the inbox, a notification, a webhook,
 * a chat app...). The broker does not know any of them: the dispatcher
 * (`QuestionChannelDispatcher`) delivers every new question on every
 * registered channel and withdraws it everywhere once it is settled.
 *
 * - `canCollect`: whether an answer may come back through this channel for
 *   this question (the channel rules, `channel-rules.ts`). A channel that
 *   cannot collect still delivers: a link to the question.
 * - `deliver` / `withdraw` run in the `questions.deliver` job, never in a
 *   request or an event listener. They must never put a secret value (or
 *   any answer value of a secret question) anywhere.
 */
export interface QuestionChannel {
  /** An open id vocabulary: 1-40 lowercase letters, digits, `.`, `_`, `-`. */
  readonly id: string;
  canCollect(q: QuestionView): boolean;
  deliver(q: QuestionView, ctx: QuestionChannelContext): Promise<void>;
  withdraw(q: QuestionView, ctx: QuestionChannelContext): Promise<void>;
}

export const QUESTION_CHANNEL_ID = /^[a-z0-9][a-z0-9_.-]{0,39}$/;

/**
 * The question channels of this application, in registration order. The
 * built-ins (`inbox`, `notifications`, `webhook`) register themselves at
 * module init; a feature adds one with {@link registerQuestionChannel}.
 */
@Injectable()
export class QuestionChannelRegistry {
  private readonly channels = new Map<string, QuestionChannel>();

  /** Adds a channel; returns the function that removes it. A duplicate id throws. */
  register(channel: QuestionChannel): () => void {
    if (!QUESTION_CHANNEL_ID.test(channel.id)) throw new Error(`Invalid question channel id "${channel.id}"`);
    if (this.channels.has(channel.id)) throw new Error(`Question channel "${channel.id}" is already registered`);
    this.channels.set(channel.id, channel);
    return () => {
      if (this.channels.get(channel.id) === channel) this.channels.delete(channel.id);
    };
  }

  list(): QuestionChannel[] {
    return [...this.channels.values()];
  }

  get(id: string): QuestionChannel | undefined {
    return this.channels.get(id);
  }
}

/** Registers a question channel with the application's registry (see {@link QuestionChannelRegistry.register}). */
export function registerQuestionChannel(registry: QuestionChannelRegistry, channel: QuestionChannel): () => void {
  return registry.register(channel);
}
