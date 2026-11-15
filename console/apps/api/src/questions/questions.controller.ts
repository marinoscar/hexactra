import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';

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
  constructor(private readonly questions: QuestionsService) {}

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
  create(@CurrentUser() user: QuestionActor, @Body() body: CreateQuestionDto): Promise<QuestionView> {
    const { asker, ...spec } = body;
    return this.questions.create(user, this.questions.parseSpec(spec), { askedBy: asker ? `agent:${asker}` : `user:${user.id}` });
  }

  /** Answer (or decline, `outcome: "cancelled"`). The first answer wins; a later one is 409. */
  @Post(':id/answer')
  @ApiDataResponse(QuestionResponseDto)
  @HttpCode(200)
  @Auth({ permissions: ['runs:write'] })
  answer(@CurrentUser() user: QuestionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: AnswerQuestionDto): Promise<QuestionView> {
    const { channel, ...answer } = body;
    return this.questions.answer(user, id, answer, { channel: channel ?? 'api' });
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
