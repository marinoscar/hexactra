import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Headers, HttpCode, Logger, Param, ParseUUIDPipe, Post, UnauthorizedException } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Public } from '@marinoscar/platform-api/identity';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';

import { QuestionResponseDto } from '../../openapi/console.responses';
import { PrismaService } from '../../prisma/prisma.service';
import { ActionTokenStore } from '../../tasks/action-token-store';
import { AnswerInvalidError, questionAnswerSchema, validateAnswer, type QuestionConstraints, type QuestionInputType, type QuestionOption } from '../questions.contract';
import { QuestionsService, type QuestionView } from '../questions.service';
import { isPublicAnswer } from './channel-rules';
import { QUESTION_TOKEN_HEADER } from './webhook.channel';

class AnswerByTokenDto extends createZodDto(questionAnswerSchema) {}

/**
 * `POST /api/questions/:id/answer-by-token`: a webhook receiver answers the
 * question it was sent, with the single-use token of the
 * `questions.question.asked` payload in the `x-question-token` header (never
 * the query string). Deliberately public: the token is the authority, and it
 * answers that one question once, before it expires, as its owner on the
 * `webhook` channel. Only a public answer (choice, multi_choice, text,
 * number, a low-risk confirm) is accepted; an invalid answer does not spend
 * the token.
 */
@ApiTags('Questions')
@Controller('questions')
export class AnswerByTokenController {
  private readonly log = new Logger(AnswerByTokenController.name);

  constructor(
    private readonly tokens: ActionTokenStore,
    private readonly prisma: PrismaService,
    private readonly questions: QuestionsService,
  ) {}

  @Post(':id/answer-by-token')
  @Public()
  @HttpCode(200)
  @ApiHeader({ name: QUESTION_TOKEN_HEADER, required: true, description: 'The single-use answer token of the questions.question.asked webhook.' })
  @ApiDataResponse(QuestionResponseDto)
  async answer(@Param('id', ParseUUIDPipe) id: string, @Headers(QUESTION_TOKEN_HEADER) token: string | undefined, @Body() body: AnswerByTokenDto): Promise<QuestionView> {
    const found = await this.tokens.find(token, 'question-webhook');
    if (found === 'used') throw new ConflictException({ code: 'TOKEN_USED', message: 'This answer token was already used' });
    if (found === 'unknown' || found === 'expired' || found.questionId !== id) {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'The answer token is missing, expired or not for this question' });
    }
    const q = await this.prisma.question.findUnique({ where: { id } });
    if (!q) throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'The answer token is missing, expired or not for this question' });
    if (q.status !== 'pending') throw new ConflictException({ code: q.status === 'expired' ? 'QUESTION_EXPIRED' : 'ALREADY_ANSWERED', message: 'This question is no longer open' });
    // The channel rule again: a webhook only ever collects a public answer.
    if (!isPublicAnswer({ input: q.input, risk: q.risk, options: null })) {
      throw new ForbiddenException({ code: 'CHANNEL_NOT_ALLOWED', message: 'This question can only be answered in the console' });
    }
    try {
      validateAnswer(
        { input: q.input as QuestionInputType, options: (q.options as unknown as QuestionOption[] | null) ?? null, constraints: (q.constraints as unknown as QuestionConstraints | null) ?? null },
        body,
      );
    } catch (e) {
      if (e instanceof AnswerInvalidError) throw new BadRequestException({ code: 'INVALID_ANSWER', message: e.message });
      throw e;
    }
    if (!(await this.tokens.claim(found))) throw new ConflictException({ code: 'TOKEN_USED', message: 'This answer token was already used' });
    const view = await this.questions.answer({ id: q.ownerUserId }, id, body, { channel: 'webhook' });
    this.log.log(`question ${id}: answered by a webhook token`);
    return view;
  }
}
