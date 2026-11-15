import { Body, ConflictException, Controller, HttpCode, Logger, Post, UnauthorizedException } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '@marinoscar/platform-api/identity';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { OkResponseDto } from '../openapi/console.responses';
import { quickAnswers } from '../questions/channels/channel-rules';
import { QuestionsService } from '../questions/questions.service';
import { QUESTION_ACTIONS, RunActionTokens, type QuestionAction } from '../tasks/run-action-token';
import { RunReminders } from '../tasks/run-reminders';
import { TasksService } from '../tasks/tasks.service';
import { HandoffAnswers } from './handoff-answers';

const actionSchema = z.object({
  token: z.string().min(10).max(1500),
  action: z.enum(['cancel', 'approve', 'snooze', ...QUESTION_ACTIONS]),
});
class NotificationActionDto extends createZodDto(actionSchema) {}

/**
 * `POST /api/notification-actions`: the buttons of a notification, pressed on
 * a phone or desktop without opening the app: a "needs you" notification's
 * Stop run, Approve and Remind me in 15 min, and a question's quick answers
 * (`answer-0`, `answer-1`: Approve/Deny of a low-risk confirm, or one of two
 * options). The service worker holds no session, so the request carries the
 * button's single-use token instead (`RunActionTokens`, spent in the
 * database); it can stop that one run, approve that one plain confirmation,
 * move that run's next reminder 15 min out, or send one of the answers the
 * token names to that one question, and nothing else.
 */
@ApiTags('Inbox')
@Controller('notification-actions')
export class NotificationActionsController {
  private readonly log = new Logger(NotificationActionsController.name);

  constructor(
    private readonly tokens: RunActionTokens,
    private readonly tasks: TasksService,
    private readonly answers: HandoffAnswers,
    private readonly reminders: RunReminders,
    private readonly questions: QuestionsService,
  ) {}

  @Post()
  @Public()
  @HttpCode(200)
  @ApiDataResponse(OkResponseDto)
  async act(@Body() body: NotificationActionDto): Promise<{ ok: true }> {
    if (body.action === 'answer-0' || body.action === 'answer-1') return this.answerQuestion(body.token, body.action);
    const claims = await this.tokens.redeem(body.token, body.action);
    if (!claims) throw new UnauthorizedException({ code: 'ACTION_EXPIRED', message: 'This notification button expired or was already used: open the run' });
    if (body.action === 'cancel') await this.tasks.cancel(claims.userId, claims.runId);
    else if (body.action === 'snooze') await this.reminders.snooze(claims.userId, claims.runId);
    else await this.answers.answer({ id: claims.userId }, claims.runId, 'completed', undefined, claims.handoffId!, { channel: 'notification' });
    this.log.log(`run ${claims.runId}: ${body.action} from a notification`);
    return { ok: true };
  }

  private async answerQuestion(token: string, action: QuestionAction): Promise<{ ok: true }> {
    const redeemed = await this.tokens.redeemQuestion(token, action);
    if (!redeemed) throw new UnauthorizedException({ code: 'ACTION_EXPIRED', message: 'This notification button expired or was already used: open the question' });
    const { claims, value } = redeemed;
    const actor = { id: claims.userId };
    // The channel rule again, from the question as it is now: a button only
    // ever sends a public answer it was offered.
    const q = await this.questions.get(actor.id, claims.questionId);
    if (!quickAnswers(q)?.some((a) => a.value === value)) throw new ConflictException({ code: 'NOT_QUICK_ANSWERABLE', message: 'Open the question to answer it' });
    await this.questions.answer(actor, claims.questionId, { outcome: 'completed', value }, { channel: 'notification' });
    this.log.log(`question ${claims.questionId}: answered from a notification`);
    return { ok: true };
  }
}
