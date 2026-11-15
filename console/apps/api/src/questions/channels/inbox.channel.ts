import { Injectable, type OnModuleInit } from '@nestjs/common';

import { QuestionChannelRegistry, type QuestionChannel } from './question-channel';

/**
 * `inbox`: the console's own Inbox (web, Android app, CLI/TUI, MCP). It reads
 * the pending questions from the broker, so there is nothing to deliver or
 * withdraw; registered so every channel the console has is listed. The
 * person is signed in, so it collects every answer (a secret on its
 * protected page).
 */
@Injectable()
export class InboxQuestionChannel implements QuestionChannel, OnModuleInit {
  readonly id = 'inbox';

  constructor(private readonly registry: QuestionChannelRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  canCollect(): boolean {
    return true;
  }

  async deliver(): Promise<void> {}

  async withdraw(): Promise<void> {}
}
