import { Body, Controller, HttpCode, Logger, Post, UnauthorizedException } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '@marinoscar/platform-api/identity';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { OkResponseDto } from '../openapi/console.responses';
import { RunActionTokens } from '../tasks/run-action-token';
import { TasksService } from '../tasks/tasks.service';
import { HandoffAnswers } from './handoff-answers';

const actionSchema = z.object({
  token: z.string().min(10).max(1000),
  action: z.enum(['cancel', 'approve']),
});
class NotificationActionDto extends createZodDto(actionSchema) {}

/**
 * `POST /api/notification-actions`: the buttons of a "needs you" notification
 * (Stop run, Approve), pressed on a phone or desktop without opening the app.
 * The service worker holds no session, so the request carries the button's
 * single-use, hour-long token instead (`RunActionTokens`); it can stop that
 * one run, or approve that one plain confirmation, and nothing else.
 */
@ApiTags('Inbox')
@Controller('notification-actions')
export class NotificationActionsController {
  private readonly log = new Logger(NotificationActionsController.name);

  constructor(
    private readonly tokens: RunActionTokens,
    private readonly tasks: TasksService,
    private readonly answers: HandoffAnswers,
  ) {}

  @Post()
  @Public()
  @HttpCode(200)
  @ApiDataResponse(OkResponseDto)
  async act(@Body() body: NotificationActionDto): Promise<{ ok: true }> {
    const claims = this.tokens.redeem(body.token, body.action);
    if (!claims) throw new UnauthorizedException({ code: 'ACTION_EXPIRED', message: 'This notification button expired or was already used: open the run' });
    if (body.action === 'cancel') await this.tasks.cancel(claims.userId, claims.runId);
    else await this.answers.answer({ id: claims.userId }, claims.runId, 'completed', undefined, claims.handoffId!);
    this.log.log(`run ${claims.runId}: ${body.action} from a notification`);
    return { ok: true };
  }
}
