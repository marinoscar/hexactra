import { Injectable } from '@nestjs/common';

import { QuestionsService } from '../questions/questions.service';
import type { QuestionAnswerInput } from '../questions/questions.contract';

/**
 * Answers the question a run waits on and resumes the run: the path the
 * Inbox and the notification buttons share, now a thin front of the
 * question broker (`QuestionsService.answerRun`). A secret value goes to the
 * fabric (single use) and is never stored or logged here.
 */
@Injectable()
export class HandoffAnswers {
  constructor(private readonly questions: QuestionsService) {}

  /** `expectHandoffId`: refuse unless the run still waits on that handoff (a notification's stale button). */
  async answer(
    user: { id: string; activeOrgId?: string | null },
    runId: string,
    outcome: 'completed' | 'cancelled',
    value?: QuestionAnswerInput['value'],
    expectHandoffId?: string,
    extra: { values?: string[]; channel?: string } = {},
  ): Promise<void> {
    await this.questions.answerRun(
      user,
      runId,
      { outcome, ...(value !== undefined ? { value } : {}), ...(extra.values ? { values: extra.values } : {}) },
      { channel: extra.channel ?? 'inbox', ...(expectHandoffId ? { expectHandoffId } : {}) },
    );
  }
}
