import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, authCredentialOf, CurrentPrincipal, CurrentUser, type RequestWithAuthCredential } from '@marinoscar/platform-api/identity';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { KgraphReviewsService } from './reviews.service';

const reviewSchema = z.object({
  id: z.string().uuid(),
  versionId: z.string(),
  procedureId: z.string().nullable(),
  status: z.enum(['pending', 'approved', 'declined', 'expired']),
  changes: z.array(z.object({ reason: z.string(), text: z.string().describe('What changes, in plain words, masked: never a typed value.') })),
  createdAt: z.string(),
  expiresAt: z.string(),
});
class ReviewResponseDto extends createZodDto(reviewSchema) {}
class ReviewsQueryDto extends createZodDto(z.object({ status: z.enum(['pending', 'approved', 'declined', 'expired']).optional() }).strict()) {}
class AnswerReviewDto extends createZodDto(z.object({ approve: z.boolean() }).strict()) {}

/** Reviews of sensitive Knowledge Graph changes (E46.17). Answering is for the signed-in owner only: no token, no OAuth app, no MCP tool. */
@ApiTags('Knowledge Graph')
@Controller('kgraph/reviews')
export class KgraphReviewsController {
  constructor(private readonly reviews: KgraphReviewsService) {}

  @Get()
  @ApiDataResponse(ReviewResponseDto, { isArray: true })
  @Auth({ permissions: ['kgraph:read'] })
  @ApiOperation({ summary: 'Changes waiting for your review', description: 'Repairs that would add or change a send, a payment, a recipient, a site, an account or a saved login. They never pause a run.' })
  list(@CurrentUser('id') userId: string, @Query() q: ReviewsQueryDto) {
    return this.reviews.list(userId, q.status);
  }

  @Get(':id')
  @ApiDataResponse(ReviewResponseDto)
  @Auth({ permissions: ['kgraph:read'] })
  @ApiOperation({ summary: 'One review' })
  get(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.reviews.get(userId, id);
  }

  @Post(':id/answer')
  @HttpCode(200)
  @ApiDataResponse(ReviewResponseDto)
  @Auth({ permissions: ['kgraph:write'] })
  @ApiOperation({ summary: 'Approve or decline a change (signed-in console only)', description: '`403 KGRAPH_REVIEW_CONSOLE_ONLY` for a personal access token, an OAuth app or any credential but a browser session. Declined: the version retires and the same change is not proposed again for 30 days. Approved: its next run verifies it, asking before every step that sends or pays; it still passes every gate on every run.' })
  answer(@CurrentUser('id') userId: string, @CurrentPrincipal() principal: { credential?: string }, @Param('id', ParseUUIDPipe) id: string, @Body() body: AnswerReviewDto, @Req() req: RequestWithAuthCredential) {
    // As the platform's own consent routes: an access JWT whose principal is a browser session; never a token, an OAuth app or a device.
    const kind = authCredentialOf(req)?.kind;
    return this.reviews.answer(userId, id, body.approve, kind === 'jwt' && principal?.credential === 'session' ? 'session' : (kind ?? null));
  }
}
