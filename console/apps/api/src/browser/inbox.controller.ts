import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { HandoffAnswers } from './handoff-answers';
import { InboxItemResponseDto, OkResponseDto } from '../openapi/console.responses';
import { QuestionsService } from '../questions/questions.service';
import type { QuestionConstraints, QuestionInputType, QuestionOption } from '../questions/questions.contract';

const respondSchema = z.object({
  outcome: z.enum(['completed', 'cancelled']),
  /** Text, a choice (its id), a number, approve/deny, or a secret (passed to the fabric, never stored or logged). */
  value: z.union([z.string().max(4096), z.number().finite()]).optional(),
  /** multi_choice: the chosen option ids. */
  values: z.array(z.string().max(64)).max(10).optional(),
});
class RespondDto extends createZodDto(respondSchema) {}

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
  risk: 'low' | 'high' | null;
  pageTitle: string | null;
  viewerUrl: string | null;
  createdAt: string;
  expiresAt: string;
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
  ) {}

  @Get()
  @ApiDataResponse(InboxItemResponseDto, { isArray: true })
  @Auth({ permissions: ['runs:read'] })
  async list(@CurrentUser('id') userId: string): Promise<InboxItem[]> {
    const rows = await this.questions.pendingWithRuns(userId);
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
        risk: (q.risk as 'low' | 'high' | null) ?? null,
        pageTitle: q.pageTitle,
        viewerUrl: q.viewerUrl,
        createdAt: q.createdAt.toISOString(),
        expiresAt: q.expiresAt.toISOString(),
      };
    });
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
    await this.answers.answer(user, runId, body.outcome, body.value, undefined, { ...(body.values ? { values: body.values } : {}), channel: 'inbox' });
    return { ok: true };
  }
}
