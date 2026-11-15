import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { JobHandlerRegistry, JobsService, registerJobReason, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../../prisma/prisma.service';
import { QUESTION_EVENT_TYPES, QuestionEvents, type QuestionEvent, type QuestionEventType } from '../question-events';
import { toQuestionView } from '../questions.service';
import { QuestionChannelRegistry, type QuestionChannelContext } from './question-channel';

/** The job type. Permanent once jobs of this type exist: never rename it. */
export const QUESTIONS_DELIVER_JOB = 'questions.deliver';

/** Why a `questions.deliver` job was enqueued (a permanent id). */
export const QUESTION_EVENT_REASON = { id: 'question_event', label: 'Question asked or settled' } as const;
registerJobReason(QUESTION_EVENT_REASON);

/** What one `questions.deliver` job does. Ids and labels only, never an answer. */
export interface QuestionDeliverPayload {
  questionId: string;
  op: 'deliver' | 'withdraw';
  event: QuestionEventType;
  answeredChannel: string | null;
}

/** A channel's failure, described without values (no message: it may quote the question or the answer). */
function describe(e: unknown): string {
  if (!(e instanceof Error)) return 'unknown error';
  const status = (e as { status?: unknown; statusCode?: unknown }).status ?? (e as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' ? `${e.name} (${status})` : e.name;
}

/**
 * Hears the question broker's events and queues the channel work: a new
 * question is delivered on every registered channel, a settled one (answered,
 * cancelled, expired) withdrawn everywhere. The listener only enqueues (the
 * platform's queue rule: no I/O in an event listener); only the replica that
 * emitted the event enqueues, so a question is delivered once.
 */
@Injectable()
export class QuestionChannelDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(QuestionChannelDispatcher.name);
  private unsubscribe: () => void = () => undefined;

  constructor(
    private readonly events: QuestionEvents,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.events.subscribe((e, meta) => (meta.local ? this.enqueue(e) : undefined));
  }

  onModuleDestroy(): void {
    this.unsubscribe();
  }

  /** The job one event becomes (exported for tests). */
  static payloadFor(e: QuestionEvent): QuestionDeliverPayload | null {
    if (!(QUESTION_EVENT_TYPES as readonly string[]).includes(e.type)) return null;
    return { questionId: e.questionId, op: e.type === 'question.asked' ? 'deliver' : 'withdraw', event: e.type, answeredChannel: e.channel ?? null };
  }

  async enqueue(e: QuestionEvent): Promise<void> {
    const payload = QuestionChannelDispatcher.payloadFor(e);
    if (!payload) return;
    try {
      await this.jobs.enqueue({
        type: QUESTIONS_DELIVER_JOB,
        reason: QUESTION_EVENT_REASON.id,
        // A withdraw must never fold into a pending delivery of the same question.
        subjectType: payload.op === 'deliver' ? 'question.deliver' : 'question.withdraw',
        subjectId: payload.questionId,
        orgId: null,
        payload: { ...payload },
      });
    } catch (err) {
      this.log.warn(`question ${e.questionId}: could not queue ${payload.op}: ${describe(err)}`);
    }
  }
}

/**
 * `questions.deliver`: runs `deliver` (a new question) or `withdraw` (a
 * settled one) on every registered channel. Each channel's failure is
 * isolated and logged without values; the job itself succeeds. One attempt:
 * a retry would deliver twice on the channels that worked. Server-only (it
 * reads the question and calls the platform's notification and webhook
 * services).
 */
@Injectable()
export class QuestionsDeliverHandler implements JobHandler, OnModuleInit {
  readonly type = QUESTIONS_DELIVER_JOB;
  readonly label = 'Deliver or withdraw a question on its channels';
  readonly profile = { maxRuntimeMs: 60_000, maxAttempts: 1 };
  private readonly log = new Logger(QuestionsDeliverHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly channels: QuestionChannelRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    await this.run(job.payload as unknown as QuestionDeliverPayload);
  }

  /** The work of one job (called directly by tests). */
  async run(p: QuestionDeliverPayload): Promise<void> {
    const row = await this.prisma.question.findUnique({ where: { id: p.questionId } });
    if (!row) return;
    const q = toQuestionView(row);
    // Delivered late, after it was settled: the withdraw job covers it.
    if (p.op === 'deliver' && q.status !== 'pending') return;
    const ctx: QuestionChannelContext = { ownerUserId: row.ownerUserId, event: p.event, answeredChannel: p.answeredChannel };
    for (const channel of this.channels.list()) {
      try {
        if (p.op === 'deliver') await channel.deliver(q, ctx);
        else await channel.withdraw(q, ctx);
      } catch (e) {
        this.log.warn(`question ${q.id}: channel ${channel.id} ${p.op} failed: ${describe(e)}`);
      }
    }
  }
}
