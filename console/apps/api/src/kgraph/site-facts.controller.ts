import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, authCredentialOf, CurrentPrincipal, CurrentUser, type RequestWithAuthCredential } from '@marinoscar/platform-api/identity';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { registrableDomain, SITE_FACT_KINDS, SITE_FACT_MAX_TEXT } from '@marinoscar/hexactra-kgraph';

import { KgraphSiteFactsService } from './site-facts.service';

const kind = z.enum(SITE_FACT_KINDS);
const status = z.enum(['proposed', 'active', 'archived']);
/** One registrable domain, lower case, no subdomain (`example.com`, `bank.co.uk`). */
const siteParam = z
  .string()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
  .refine((s) => s.includes('.') && registrableDomain(s) === s, { message: 'a registrable domain, such as example.com' });
const idParam = z.string().min(1).max(200).regex(/^[A-Za-z0-9:_-]+$/);

const siteFactSchema = z.object({
  id: z.string(),
  site: z.string(),
  kind,
  text: z.string().describe('At most 300 characters, shown as text. Data about the site, never an instruction or a permission.'),
  source: z.enum(['owner', 'derived', 'agent_proposed']),
  status,
  approvedBy: z
    .enum(['owner', 'auto'])
    .nullable()
    .describe('How the fact became active (E46.36): `owner` (you approved, typed or restored it) or `auto` (your setting "Approve facts from server records automatically", for a derived navigation, timing or quirk fact). Null while it is a proposal or after you declined it.'),
  evidence: z.object({ runId: z.string().nullable(), steps: z.number().int(), screens: z.number().int() }).describe('What a proposal came from: the run and how many of its calls and screens. Ids and counts only.'),
  declinedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
class SiteFactResponseDto extends createZodDto(siteFactSchema) {}
class ProposeSiteFactResponseDto extends createZodDto(
  z.object({
    outcome: z.enum(['proposed', 'known', 'suppressed']).describe('`proposed`: stored, waiting for your review. `known`: you already have this fact. `suppressed`: you declined it in the last 30 days.'),
    fact: siteFactSchema.nullable().describe('The stored proposal, or the fact you already have; null when suppressed.'),
  }),
) {}
class SiteSummaryResponseDto extends createZodDto(z.object({ site: z.string(), active: z.number().int(), proposed: z.number().int(), archived: z.number().int() })) {}
class ReviewsQueryDto extends createZodDto(
  z
    .object({ approvedBy: z.enum(['auto']).optional().describe('`auto`: instead of the proposals, the facts your setting "Approve facts from server records automatically" made active in the last 30 days (still active), newest first (E46.36).') })
    .strict(),
) {}
class FactsQueryDto extends createZodDto(z.object({ status: status.optional() }).strict()) {}
class CreateSiteFactDto extends createZodDto(z.object({ kind, text: z.string().trim().min(1).max(SITE_FACT_MAX_TEXT) }).strict()) {}
class UpdateSiteFactDto extends createZodDto(
  z
    .object({ kind: kind.optional(), text: z.string().trim().min(1).max(SITE_FACT_MAX_TEXT).optional(), status: z.enum(['active', 'archived']).optional().describe('`archived` sets a fact aside; `active` restores an archived one. A proposal is approved in Reviews.') })
    .strict()
    .refine((b) => b.kind !== undefined || b.text !== undefined || b.status !== undefined, { message: 'nothing to change' }),
) {}
class AnswerSiteFactDto extends createZodDto(
  z.object({ approve: z.boolean(), kind: kind.optional().describe('Approve with your own edit of the kind.'), text: z.string().trim().min(1).max(SITE_FACT_MAX_TEXT).optional().describe('Approve with your own edit of the text.') }).strict(),
) {}

class SiteParamDto extends createZodDto(z.object({ site: siteParam }).strict()) {}
class IdParamDto extends createZodDto(z.object({ id: idParam }).strict()) {}

/**
 * Site facts (phase 5, E46.31): short notes about one site that a later run reads as data. Typing a fact makes it active; a proposal (derived
 * after a run, or the agent's) waits in Reviews. A secret, an instruction or a link to another site is refused with `422`. Another user's
 * fact answers `404`. Over MCP (E46.35), `site_facts_list` reads them and `site_fact_propose` proposes one; no tool approves, edits or deletes.
 */
@ApiTags('Knowledge Graph')
@Controller('kgraph')
export class KgraphSiteFactsController {
  constructor(private readonly facts: KgraphSiteFactsService) {}

  @Get('sites')
  @ApiDataResponse(SiteSummaryResponseDto, { isArray: true })
  @Auth({ permissions: ['kgraph:read'] })
  @ApiOperation({ summary: 'Your sites with facts', description: 'Each site (registrable domain) you have facts about, with how many are active, proposed and archived.' })
  sites(@CurrentUser('id') userId: string) {
    return this.facts.sites(userId);
  }

  @Get('sites/:site/facts')
  @ApiDataResponse(SiteFactResponseDto, { isArray: true })
  @Auth({ permissions: ['kgraph:read'] })
  @ApiOperation({ summary: "A site's facts", description: 'Oldest first; optionally only one status.' })
  list(@CurrentUser('id') userId: string, @Param() p: SiteParamDto, @Query() q: FactsQueryDto) {
    return this.facts.facts(userId, p.site, q.status);
  }

  @Post('sites/:site/facts')
  @ApiDataResponse(SiteFactResponseDto, { status: 201 })
  @Auth({ permissions: ['kgraph:write'] })
  @ApiOperation({ summary: 'Add a fact about a site (active at once)', description: 'Your own words, active at once. `422 KGRAPH_SITE_FACT_REFUSED` for a password, code, token or full number, an instruction, or a link to another site. `409 KGRAPH_OFF` while the Knowledge Graph is off.' })
  create(@CurrentUser('id') userId: string, @Param() p: SiteParamDto, @Body() body: CreateSiteFactDto) {
    return this.facts.create(userId, p.site, body);
  }

  @Post('sites/:site/facts/proposals')
  @ApiDataResponse(ProposeSiteFactResponseDto, { status: 201 })
  @Auth({ permissions: ['kgraph:write'] })
  @ApiOperation({
    summary: 'Propose a fact about a site (waits for your review)',
    description:
      "An agent's proposal (E46.35; the MCP tool `site_fact_propose` calls it): always stored `proposed` with source `agent_proposed`, never active; you approve it in Knowledge Graph reviews, signed in. `outcome` is `known` when you already have the fact (whatever its status) and `suppressed` when you declined it in the last 30 days. `422 KGRAPH_SITE_FACT_REFUSED` (with the rules broken, never the text) for a password, code, token or full number, an instruction, or a link to another site. `409 KGRAPH_OFF` while the Knowledge Graph is off.",
  })
  propose(@CurrentUser('id') userId: string, @Param() p: SiteParamDto, @Body() body: CreateSiteFactDto, @Req() req: RequestWithAuthCredential) {
    const credential = authCredentialOf(req);
    return this.facts.proposeByClient(userId, p.site, body, credential ? { kind: credential.kind, ...(credential.kind === 'oauth' ? { clientId: credential.clientId } : {}) } : null);
  }

  @Patch('site-facts/:id')
  @ApiDataResponse(SiteFactResponseDto)
  @Auth({ permissions: ['kgraph:write'] })
  @ApiOperation({ summary: 'Edit, archive or restore a site fact', description: '`422 KGRAPH_SITE_FACT_REFUSED` for a refused text; `409 KGRAPH_SITE_FACT_EXISTS` when the edit equals another of your facts; `409 KGRAPH_SITE_FACT_STATUS` for a move that is not allowed (a proposal is approved in Reviews).' })
  update(@CurrentUser('id') userId: string, @Param() p: IdParamDto, @Body() body: UpdateSiteFactDto) {
    return this.facts.update(userId, p.id, body);
  }

  @Delete('site-facts/:id')
  @HttpCode(204)
  @Auth({ permissions: ['kgraph:write'] })
  @ApiOperation({ summary: 'Delete a site fact', description: 'Permanently. A deleted proposal may be proposed again.' })
  async remove(@CurrentUser('id') userId: string, @Param() p: IdParamDto): Promise<void> {
    await this.facts.remove(userId, p.id);
  }
}

/** Site fact proposals in Knowledge Graph reviews (E46.31). Answering is for the signed-in owner only: no token, no OAuth app, no MCP tool. */
@ApiTags('Knowledge Graph')
@Controller('kgraph/reviews/site-facts')
export class KgraphSiteFactReviewsController {
  constructor(private readonly facts: KgraphSiteFactsService) {}

  @Get()
  @ApiDataResponse(SiteFactResponseDto, { isArray: true })
  @Auth({ permissions: ['kgraph:read'] })
  @ApiOperation({ summary: 'Site facts waiting for your review', description: 'Proposals derived from your runs or written by the agent. None is used by a run until you approve it.' })
  list(@CurrentUser('id') userId: string, @Query() q: ReviewsQueryDto) {
    return q.approvedBy === 'auto' ? this.facts.autoApproved(userId) : this.facts.proposals(userId);
  }

  @Post(':id/answer')
  @HttpCode(200)
  @ApiDataResponse(SiteFactResponseDto)
  @Auth({ permissions: ['kgraph:write'] })
  @ApiOperation({ summary: 'Approve, edit then approve, or decline a site fact (signed-in console only)', description: '`403 KGRAPH_REVIEW_CONSOLE_ONLY` for a personal access token, an OAuth app or any credential but a browser session. Approved: the fact is active (with your edit, if any). Declined: it is archived and the same fact is not proposed again for 30 days.' })
  answer(@CurrentUser('id') userId: string, @CurrentPrincipal() principal: { credential?: string }, @Param() p: IdParamDto, @Body() body: AnswerSiteFactDto, @Req() req: RequestWithAuthCredential) {
    // As the review answer route: an access JWT whose principal is a browser session; never a token, an OAuth app or a device.
    const credential = authCredentialOf(req)?.kind;
    return this.facts.answer(userId, p.id, body, credential === 'jwt' && principal?.credential === 'session' ? 'session' : (credential ?? null));
  }
}
