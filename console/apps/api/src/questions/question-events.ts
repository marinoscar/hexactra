import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EVENT_BUS, type EventBus } from '@marinoscar/platform-api/host';

/** The bus channel every question event goes on (cross-replica with the postgres bus). */
export const QUESTION_EVENTS_CHANNEL = 'questions.events';

/** What happened to a question. Channels (#289) subscribe to these. */
export const QUESTION_EVENT_TYPES = ['question.asked', 'question.answered', 'question.cancelled', 'question.expired'] as const;
export type QuestionEventType = (typeof QUESTION_EVENT_TYPES)[number];

/**
 * One question event. Ids and labels only, never an answer value: a
 * subscriber re-reads the question through `QuestionsService`.
 */
export interface QuestionEvent {
  type: QuestionEventType;
  questionId: string;
  ownerUserId: string;
  runId: string | null;
  input: string;
  kind: string;
  status: string;
  /** The channel that answered (`question.answered` / `question.cancelled`). */
  channel?: string | null;
}

/** Where an event came from: `local` when this process emitted it. */
export interface QuestionEventMeta {
  local: boolean;
}

export type QuestionEventHandler = (e: QuestionEvent, meta: QuestionEventMeta) => void | Promise<void>;

/**
 * The question broker's hook for channels: `emit` after the write committed,
 * `subscribe` to hear every replica's events. Rides the platform's
 * `EVENT_BUS`; without one (a bare test module) it is in-process.
 */
@Injectable()
export class QuestionEvents {
  private readonly log = new Logger(QuestionEvents.name);
  private readonly local = new Set<QuestionEventHandler>();

  constructor(@Optional() @Inject(EVENT_BUS) private readonly bus?: EventBus) {}

  async emit(e: QuestionEvent): Promise<void> {
    if (this.bus) {
      try {
        await this.bus.publish(QUESTION_EVENTS_CHANNEL, e);
      } catch (err) {
        this.log.warn(`publish ${e.type} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    for (const h of [...this.local]) {
      try {
        await h(e, { local: true });
      } catch (err) {
        this.log.warn(`handler for ${e.type} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Returns the unsubscribe function. A handler must not do long work inline
   * (queue a job). Every replica hears every event; `meta.local` tells the
   * one that emitted it, for work that must happen once.
   */
  subscribe(handler: QuestionEventHandler): () => void {
    if (this.bus) return this.bus.subscribe<QuestionEvent>(QUESTION_EVENTS_CHANNEL, (e, meta) => handler(e, { local: meta.local }));
    this.local.add(handler);
    return () => void this.local.delete(handler);
  }
}
