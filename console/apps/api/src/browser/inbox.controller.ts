import { BadRequestException, Body, Controller, Get, HttpCode, Optional, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { HandoffAnswers } from './handoff-answers';
import { InboxHistoryResponseDto, InboxItemResponseDto, OkResponseDto } from '../openapi/console.responses';
import { requestOutcomeWords } from '../questions/chat-request-record';
import { maskSensitive } from '../tasks/mask';
import { stepQuestionView, type StepQuestionView } from '../tasks/run-trace.view';
import { QuestionsService, isOwnerCardInput, saveLoginCardOf, type SaveLoginCard } from '../questions/questions.service';
import type { MemoryProposal, QuestionConstraints, QuestionInputType, QuestionOption, QuestionRememberable } from '../questions/questions.contract';
import { RequestClientService } from '../connected-apps/request-client';

const respondSchema = z.object({
  outcome: z.enum(['completed', 'cancelled']),
  /** Text, a choice (its id), a number, approve/deny, or a secret (passed to the fabric, never stored or logged). */
  value: z.union([z.string().max(4096), z.number().finite()]).optional(),
  /** multi_choice: the chosen option ids. */
  values: z.array(z.string().max(64)).max(10).optional(),
  /** credentials: the password (passed to the fabric, never stored or logged; the username is `value`). */
  secret: z.string().max(4096).optional(),
  /** The person's choice for the question's "remember me" option. */
  remember: z.boolean().optional(),
});
class RespondDto extends createZodDto(respondSchema) {}

const historyQuerySchema = z.object({
  status: z.enum(['answered', 'cancelled', 'expired']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
class HistoryQueryDto extends createZodDto(historyQuerySchema) {}

/** A request that is over (E40.3). Masked; a secret's or a sign-in's value is never here. */
export interface InboxHistoryItem {
  questionId: string;
  runId: string | null;
  conversationId: string | null;
  goal: string;
  askedBy: string;
  kind: string;
  input: QuestionInputType;
  prompt: string;
  status: 'answered' | 'cancelled' | 'expired';
  outcome: string;
  answer: StepQuestionView['answer'];
  createdAt: string;
  settledAt: string | null;
}

const encodeCursor = (at: Date, id: string) => Buffer.from(JSON.stringify({ at: at.toISOString(), id })).toString('base64url');
function decodeCursor(text: string): { at: Date; id: string } {
  try {
    const c = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as { at?: unknown; id?: unknown };
    if (typeof c.at === 'string' && typeof c.id === 'string' && !Number.isNaN(Date.parse(c.at)) && /^[0-9a-f-]{36}$/i.test(c.id)) return { at: new Date(c.at), id: c.id };
  } catch {
    // Falls through to the typed error.
  }
  throw new BadRequestException({ code: 'INVALID_CURSOR', message: 'The cursor is not one a history page returned. Start again from the first page' });
}

/** One question waiting for the user. */
export interface InboxItem {
  questionId: string;
  /** Null for a free-standing question (answered with POST /api/questions/:id/answer). */
  runId: string | null;
  /** The chat whose run asks (#488); null for every other request. */
  conversationId: string | null;
  goal: string;
  handoffId: string | null;
  askedBy: string;
  kind: string;
  prompt: string;
  input: QuestionInputType;
  /** Option ids (kept for older clients; `options` carries the labels). */
  choices: string[];
  options: QuestionOption[] | null;
  constraints: QuestionConstraints | null;
  confirmLabel: string | null;
  denyLabel: string | null;
  /** credentials and secret: the site's "remember me" option, in the page's words (#527). */
  rememberLabel: string | null;
  /** What "Don't ask again" would remember (#555), computed by the server; null when it cannot be remembered. */
  rememberable: QuestionRememberable | null;
  risk: 'low' | 'high' | null;
  pageTitle: string | null;
  viewerUrl: string | null;
  createdAt: string;
  expiresAt: string;
  /** False for a memory proposal (#553): no run waits on it. */
  blocking: boolean;
  /** memory (#553): the proposed memory. */
  proposal: MemoryProposal | null;
  /** save_login (E37.4b): the card of "Save this login?"; null for every other input. */
  saveLogin: SaveLoginCard | null;
}

/**
 * `/api/inbox`: what the user's agents are waiting for (CAPTCHAs, codes,
 * logins, confirmations, choices), answered here instead of through a link.
 * Read from the question broker (no fabric round trip per item); a secret
 * goes straight to the fabric (single use) and is never stored or logged.
 */
@ApiTags('Inbox')
@Controller('inbox')
export class InboxController {
  constructor(
    private readonly questions: QuestionsService,
    private readonly answers: HandoffAnswers,
    @Optional() private readonly clients?: RequestClientService,
  ) {}

  @Get()
  @ApiDataResponse(InboxItemResponseDto, { isArray: true })
  @Auth({ permissions: ['runs:read'] })
  async list(@CurrentUser('id') userId: string, @Req() req?: object): Promise<InboxItem[]> {
    // An MCP client (an AI app, or the console's own MCP tools) never sees a memory proposal (#553).
    const hideMemory = (await this.clients?.resolve(req))?.origin === 'mcp';
    const rows = (await this.questions.pendingWithRuns(userId)).filter((q) => !(hideMemory && isOwnerCardInput(q.input)));
    return rows.map((q) => {
      const options = (q.options as unknown as QuestionOption[] | null) ?? null;
      return {
        questionId: q.id,
        runId: q.runId,
        conversationId: q.run?.conversationId ?? null,
        goal: q.run?.goal ?? q.prompt.slice(0, 300),
        handoffId: q.handoffId,
        askedBy: q.askedBy,
        kind: q.kind,
        prompt: q.prompt,
        input: q.input as QuestionInputType,
        choices: options?.map((o) => o.id) ?? [],
        options,
        constraints: (q.constraints as unknown as QuestionConstraints | null) ?? null,
        confirmLabel: q.confirmLabel,
        denyLabel: q.denyLabel,
        rememberLabel: q.rememberLabel,
        rememberable: (q.rememberable as unknown as QuestionRememberable | null) ?? null,
        fields: q.fields ?? null,
        risk: (q.risk as 'low' | 'high' | null) ?? null,
        pageTitle: q.pageTitle,
        viewerUrl: q.viewerUrl,
        createdAt: q.createdAt.toISOString(),
        expiresAt: q.expiresAt.toISOString(),
        blocking: q.blocking,
        proposal: q.input === 'memory' ? ((q.proposal as unknown as MemoryProposal | null) ?? null) : null,
        saveLogin: saveLoginCardOf(q),
      };
    });
  }

  /**
   * What was asked and is over (E40.3): answered, declined and expired requests, newest first, so the owner can see
   * later that information was provided, refused or missed. Values are masked; a secret's never appears.
   */
  @Get('history')
  @ApiDataResponse(InboxHistoryResponseDto)
  @Auth({ permissions: ['runs:read'] })
  async history(@CurrentUser('id') userId: string, @Query() query: HistoryQueryDto, @Req() req?: object): Promise<{ items: InboxHistoryItem[]; nextCursor: string | null }> {
    const hideMemory = (await this.clients?.resolve(req))?.origin === 'mcp';
    const limit = query.limit ?? 30;
    const rows = await this.questions.settledWithRuns(userId, { status: query.status, before: query.cursor ? decodeCursor(query.cursor) : undefined, limit: limit + 1 });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const items = page
      .filter((q) => !(hideMemory && isOwnerCardInput(q.input)))
      .map((q) => {
        const view = stepQuestionView(q);
        // A choice reads as its labels (masked by the view), not its option ids.
        if (view.answer?.value && view.options?.length) view.answer.value = view.answer.value.split(', ').map((v) => view.options!.find((o) => o.id === v)?.label ?? v).join(', ');
        return {
          questionId: q.id,
          runId: q.runId,
          conversationId: q.run?.conversationId ?? null,
          goal: maskSensitive((q.run?.goal ?? q.prompt).slice(0, 300)).text,
          askedBy: q.askedBy,
          kind: q.kind,
          input: q.input as QuestionInputType,
          prompt: view.prompt,
          status: q.status as InboxHistoryItem['status'],
          outcome: requestOutcomeWords(q),
          answer: view.answer,
          createdAt: q.createdAt.toISOString(),
          settledAt: (q.answeredAt ?? (q.status === 'expired' ? q.expiresAt : null))?.toISOString() ?? null,
        };
      });
    return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null };
  }

  /** Answer (or decline) the question the run waits on, then resume the run at once. */
  @Post(':runId/respond')
  @ApiDataResponse(OkResponseDto, { status: 201 })
  @HttpCode(200)
  @Auth({ permissions: ['runs:write'] })
  async respond(
    @CurrentUser() user: { id: string; activeOrgId?: string | null },
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body() body: RespondDto,
  ): Promise<{ ok: true }> {
    await this.answers.answer(user, runId, body.outcome, body.value, undefined, { ...(body.values ? { values: body.values } : {}), ...(body.secret !== undefined ? { secret: body.secret } : {}), ...(body.remember !== undefined ? { remember: body.remember } : {}), channel: 'inbox' });
    return { ok: true };
  }
}
