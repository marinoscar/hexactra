import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { FabricClient } from '../fabric/fabric.client';
import { HandoffAnswers } from './handoff-answers';
import { PrismaService } from '../prisma/prisma.service';
import { InboxItemResponseDto, OkResponseDto } from '../openapi/console.responses';

const respondSchema = z.object({
  outcome: z.enum(['completed', 'cancelled']),
  /** Text, a choice, or a secret (passed to the fabric, never stored or logged). */
  value: z.string().max(4096).optional(),
});
class RespondDto extends createZodDto(respondSchema) {}

interface FabricHandoffView {
  id: string;
  kind: string;
  prompt: string;
  input: 'none' | 'text' | 'secret' | 'choice';
  choices: string[];
  status: string;
  page?: { url?: string; title?: string };
  viewer_url?: string;
  created_at: string;
  expires_at: string;
}

/** One request from an agent waiting for the user. */
export interface InboxItem {
  runId: string;
  goal: string;
  handoffId: string;
  kind: string;
  prompt: string;
  input: FabricHandoffView['input'];
  choices: string[];
  pageTitle: string | null;
  viewerUrl: string | null;
  createdAt: string;
  expiresAt: string;
}

/**
 * `/api/inbox`: what the user's agents are waiting for (CAPTCHAs, codes,
 * logins, confirmations), answered here instead of through a link. The
 * console answers the fabric with its service token; a secret goes straight
 * to the fabric (single use) and is never stored or logged here.
 */
@ApiTags('Inbox')
@Controller('inbox')
export class InboxController {

  constructor(
    private readonly prisma: PrismaService,
    private readonly fabric: FabricClient,
    private readonly answers: HandoffAnswers,
  ) {}

  @Get()
  @ApiDataResponse(InboxItemResponseDto, { isArray: true })
  @Auth({ permissions: ['runs:read'] })
  async list(@CurrentUser('id') userId: string): Promise<InboxItem[]> {
    const runs = await this.prisma.forUser({ userId }).run.findMany({
      where: { status: 'waiting_human', handoffId: { not: null } },
      select: { id: true, goal: true, handoffId: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const items: InboxItem[] = [];
    for (const r of runs) {
      const h = await this.fabric.request<FabricHandoffView>('GET', `/v1/handoffs/${r.handoffId}`).catch(() => null);
      if (!h || h.status !== 'pending') continue;
      items.push({
        runId: r.id,
        goal: r.goal,
        handoffId: h.id,
        kind: h.kind,
        prompt: h.prompt,
        input: h.input,
        choices: h.choices ?? [],
        pageTitle: h.page?.title ?? null,
        viewerUrl: h.viewer_url ?? null,
        createdAt: h.created_at,
        expiresAt: h.expires_at,
      });
    }
    return items;
  }

  /** Answer (or decline) the request, then resume the run at once. */
  @Post(':runId/respond')
  @ApiDataResponse(OkResponseDto, { status: 201 })
  @HttpCode(200)
  @Auth({ permissions: ['runs:write'] })
  async respond(
    @CurrentUser() user: { id: string; activeOrgId?: string | null },
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body() body: RespondDto,
  ): Promise<{ ok: true }> {
    await this.answers.answer(user, runId, body.outcome, body.value);
    return { ok: true };
  }
}
