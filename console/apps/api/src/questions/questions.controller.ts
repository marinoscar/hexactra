import { Body, Controller, Get, HttpCode, Optional, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';

import { RequestClientService } from '../connected-apps/request-client';
import { QuestionResponseDto } from '../openapi/console.responses';
import { AnswerQuestionDto, CancelQuestionDto, CreateQuestionDto, GetQuestionDto, ListQuestionsDto } from './questions.schemas';
import { QuestionsService, type QuestionActor, type QuestionView } from './questions.service';

/**
 * `/api/questions`: the question broker. An agent (with its user's token)
 * asks its user a question and waits for the answer (`GET /:id?waitMs=`);
 * the person answers from any channel. Owner-only: another user's question
 * is a 404. A secret is never returned (`response.valueWithheld`).
 */
@ApiTags('Questions')
@Controller('questions')
export class QuestionsController {
  constructor(
    private readonly questions: QuestionsService,
    @Optional() private readonly clients?: RequestClientService,
  ) {}

  @Get()
  @ApiDataResponse(QuestionResponseDto, { isArray: true })
  @Auth({ permissions: ['runs:read'] })
  list(@CurrentUser('id') userId: string, @Query() q: ListQuestionsDto): Promise<QuestionView[]> {
    return this.questions.list(userId, q);
  }

  /** One question; `waitMs` (≤ 30000) holds the request while it is pending. */
  @Get(':id')
  @ApiDataResponse(QuestionResponseDto)
  @Auth({ permissions: ['runs:read'] })
  get(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Query() q: GetQuestionDto): Promise<QuestionView> {
    return this.questions.get(userId, id, q.waitMs);
  }

  /** Ask a free-standing question of yourself (every input but secret, which needs a browser session). */
  @Post()
  @ApiDataResponse(QuestionResponseDto, { status: 201 })
  @Auth({ permissions: ['runs:write'] })
  async create(@CurrentUser() user: QuestionActor, @Body() body: CreateQuestionDto, @Req() req?: object): Promise<QuestionView> {
    const { asker, ...spec } = body;
    // The AI app that asks (#464), from the request's credential: never the free-text `asker`.
    const client = (await this.clients?.resolve(req)) ?? null;
    return this.questions.create(user, this.questions.parseSpec(spec), { askedBy: asker ? `agent:${asker}` : `user:${user.id}`, client: client && client.origin === 'mcp' ? client : null });
  }

  /** Answer (or decline, `outcome: "cancelled"`). The first answer wins; a later one is 409. */
  @Post(':id/answer')
  @ApiDataResponse(QuestionResponseDto)
  @HttpCode(200)
  @Auth({ permissions: ['runs:write'] })
  async answer(@CurrentUser() user: QuestionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: AnswerQuestionDto, @Req() req?: object): Promise<QuestionView> {
    const { channel, ...answer } = body;
    // "Don't ask again" (#555) is the person's own tick in the signed-in web or Android app: the request's origin,
    // from its credential (never the declared channel), must be one of those. A token, the CLI and an AI app approve once.
    const rememberAllowed = answer.rememberRule ? ['web', 'android'].includes((await this.clients?.resolve(req))?.origin ?? '') : true;
    return this.questions.answer(user, id, answer, { channel: channel ?? 'api', rememberAllowed });
  }

  /** Decline the question (the same as answering it with `outcome: "cancelled"`). */
  @Post(':id/cancel')
  @ApiDataResponse(QuestionResponseDto)
  @HttpCode(200)
  @Auth({ permissions: ['runs:write'] })
  cancel(@CurrentUser() user: QuestionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: CancelQuestionDto): Promise<QuestionView> {
    return this.questions.cancel(user, id, { channel: body?.channel ?? 'api' });
  }
}
