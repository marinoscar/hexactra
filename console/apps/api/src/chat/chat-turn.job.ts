import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AiError } from '@marinoscar/platform-api/ai';
import { JobHandlerRegistry, JobsService, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';

import { CHAT_TURN_JOB, CHAT_TURN_MAX_RUNTIME_MS, CHAT_TURN_MAX_WAITS, CHAT_TURN_RETRY_DELAY_MS, enqueueChatTurn, type ChatTurnPayload } from './chat-turn.enqueue';
import { ChatTurnService } from './chat-turn.service';

/** Queues a chat's turn: what the controller calls after it stored the owner's message. */
@Injectable()
export class ChatTurnQueue {
  constructor(private readonly jobs: JobsService) {}

  request(conversationId: string, userId: string, orgId: string | null): Promise<void> {
    return enqueueChatTurn(this.jobs, { conversationId, userId, orgId });
  }
}

/**
 * `chat.turn`: one turn of a chat (#484). Server-only: it calls the AI slice
 * under the user's key path. One attempt: a turn may have started a run, so a
 * failure is written into the thread, not retried. A chat that is busy with
 * another turn is not a failure: the job queues itself again a moment later.
 */
@Injectable()
export class ChatTurnHandler implements JobHandler, OnModuleInit {
  readonly type = CHAT_TURN_JOB;
  readonly label = 'Answer a chat message';
  readonly profile = { maxRuntimeMs: CHAT_TURN_MAX_RUNTIME_MS, maxAttempts: 1 };
  private readonly log = new Logger(ChatTurnHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly turns: ChatTurnService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const p = job.payload as unknown as ChatTurnPayload;
    const orgId = p.orgId ?? job.orgId ?? null;
    try {
      const outcome = await this.turns.run(p.conversationId, p.userId, orgId);
      this.log.log(`job ${job.id}: chat ${p.conversationId} ${outcome}`);
      if (outcome !== 'busy') return;
      const waits = (p.waits ?? 0) + 1;
      if (waits > CHAT_TURN_MAX_WAITS) return void this.log.warn(`job ${job.id}: chat ${p.conversationId} stayed busy; giving up`);
      await enqueueChatTurn(this.jobs, { conversationId: p.conversationId, userId: p.userId, orgId, waits }, 'chat_turn_busy', CHAT_TURN_RETRY_DELAY_MS);
    } catch (e) {
      if (e instanceof AiError) throw e.toRateLimitError() ?? e;
      throw e;
    }
  }
}
