import { Body, Controller, Get, HttpCode, NotFoundException, Optional, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';

import { RequestClientService } from '../connected-apps/request-client';
import { QuestionResponseDto } from '../openapi/console.responses';
import { AnswerQuestionDto, CancelQuestionDto, CreateQuestionDto, GetQuestionDto, ListQuestionsDto } from './questions.schemas';
import { MEMORY_ANSWER_CHANNELS, channelId } from './channels/channel-rules';
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
  async list(@CurrentUser('id') userId: string, @Query() q: ListQuestionsDto, @Req() req?: object): Promise<QuestionView[]> {
    const rows = await this.questions.list(userId, q);
    // An MCP client (an AI app, or the console's own MCP tools) never reads a memory proposal (#553).
    return (await this.fromMcp(req)) ? rows.filter((r) => r.input !== 'memory') : rows;
  }

  /** Whether the request came through the MCP endpoint (an AI app or an MCP client): memory proposals are not theirs to read or answer (#553). */
  private async fromMcp(req?: object): Promise<boolean> {
    return (await this.clients?.resolve(req))?.origin === 'mcp';
  }

  /** The channel an answer is recorded under: through MCP never one of the console's own signed-in channels, whatever the body says (#553). */
  private async channelOf(req: object | undefined, claimed: string | undefined): Promise<string> {
    const channel = claimed ?? 'api';
    return MEMORY_ANSWER_CHANNELS.includes(channelId(channel)) && (await this.fromMcp(req)) ? 'mcp' : channel;
  }

  /** A memory proposal is a 404 to an MCP client (#553). */
  private async visible(req: object | undefined, view: QuestionView): Promise<QuestionView> {
    if (view.input === 'memory' && (await this.fromMcp(req))) throw new NotFoundException({ code: 'QUESTION_NOT_FOUND', message: 'Question not found' });
    return view;
  }

  /** One question; `waitMs` (≤ 30000) holds the request while it is pending. */
  @Get(':id')
  @ApiDataResponse(QuestionResponseDto)
  @Auth({ permissions: ['runs:read'] })
  async get(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Query() q: GetQuestionDto, @Req() req?: object): Promise<QuestionView> {
    return this.visible(req, await this.questions.get(userId, id, q.waitMs));
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
    // Through MCP the channel is never the console's own, whatever the body says (#553).
    return this.questions.answer(user, id, answer, { channel: await this.channelOf(req, channel) });
  }

  /** Decline the question (the same as answering it with `outcome: "cancelled"`). */
  @Post(':id/cancel')
  @ApiDataResponse(QuestionResponseDto)
  @HttpCode(200)
  @Auth({ permissions: ['runs:write'] })
  async cancel(@CurrentUser() user: QuestionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: CancelQuestionDto, @Req() req?: object): Promise<QuestionView> {
    return this.questions.cancel(user, id, { channel: await this.channelOf(req, body?.channel) });
  }
}
