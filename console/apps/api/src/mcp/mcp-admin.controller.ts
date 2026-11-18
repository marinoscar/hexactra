import { Controller, Delete, Get, HttpCode, NotFoundException, Optional, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser, OAUTH_AUDIT_ACTIONS, OAuthGrantService, OAuthServerSettingsReader } from '@marinoscar/platform-api/identity';

import { scopeViews } from '../connected-apps/connected-apps.service';
import { clientLabel, friendlyAppName } from '../connected-apps/request-client';
import { PrismaService } from '../prisma/prisma.service';
import { McpActivityService } from './mcp-activity.service';
import {
  ActivityPageResponseDto,
  ActivityQueryDto,
  AdminActivityQueryDto,
  AdminConnectedAppListResponseDto,
  McpStatusResponseDto,
  type AdminConnectedApp,
  type McpStatus,
} from './mcp-admin.schemas';
import { McpSettingsReader } from './mcp-settings.reader';
import { MCP_PATH } from './mcp.path';
import { isPublicHttpsUrl } from './mcp.public-url';

/** The scopes a "high-risk grant" holds one of (Doctor `mcp.high_risk_grants`, the status). */
export const HIGH_RISK_GRANT_SCOPES = ['browser:evaluate', 'desktop:control', 'policies:write'] as const;

const DAY_MS = 86_400_000;

/** Counts of the MCP endpoint's connections, for the status and the Doctor. */
export async function grantCounts(prisma: PrismaService): Promise<{ connectedApps: number; connectedUsers: number; highRiskGrants: number }> {
  const [connectedApps, users, highRiskGrants] = await Promise.all([
    prisma.oAuthGrant.count({ where: { revokedAt: null } }),
    prisma.oAuthGrant.findMany({ where: { revokedAt: null }, distinct: ['userId'], select: { userId: true } }),
    prisma.oAuthGrant.count({ where: { revokedAt: null, scopes: { hasSome: [...HIGH_RISK_GRANT_SCOPES] } } }),
  ]);
  return { connectedApps, connectedUsers: users.length, highRiskGrants };
}

/**
 * The audit trail of external AI apps (#465) and their administration:
 *
 *   GET    /api/connected-apps/activity        your own trail (`runs:read`)
 *   GET    /api/admin/mcp/activity             every user's (`mcp_activity:read`)
 *   GET    /api/admin/mcp/status               the switches and counts (`system_settings:read`; `hexactra mcp status`)
 *   GET    /api/admin/connected-apps           every user's connected apps (`oauth_clients:read`)
 *   DELETE /api/admin/connected-apps/grants/:id  disconnect one (`oauth_clients:write`)
 *
 * The own trail lives under `/api/connected-apps`, not `/api/mcp/*`: the
 * `/api/mcp` prefix is the OAuth protected resource, where an app's `oat_`
 * token is admitted, and an app must not read the audit trail of itself.
 */
@ApiTags('Connected apps')
@Controller()
export class McpAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: McpActivityService,
    private readonly settings: McpSettingsReader,
    private readonly config: ConfigService,
    @Optional() private readonly oauth?: OAuthServerSettingsReader,
    @Optional() private readonly grants?: OAuthGrantService,
  ) {}

  @Get('connected-apps/activity')
  @ApiOperation({
    summary: 'What your AI apps did',
    description:
      'Your audit trail of the MCP endpoint, newest first: one row per tool call from an app signed in with OAuth or a personal access token, and per refusal (kill switch, rate limit, step-up) and per change of an app\'s limits. Sanitized: never typed text, a script or a result. Keyset-paged with `cursor`.',
  })
  @ApiDataResponse(ActivityPageResponseDto)
  @Auth({ permissions: ['runs:read'] })
  own(@CurrentUser('id') userId: string, @Query() q: ActivityQueryDto) {
    return this.activity.listOwn(userId, q);
  }

  @Get('admin/mcp/activity')
  @ApiOperation({ summary: "Every user's AI app activity (Admin)", description: 'The audit trail of the MCP endpoint for every user, filterable like your own and by user.' })
  @ApiDataResponse(ActivityPageResponseDto)
  @Auth({ permissions: ['mcp_activity:read'] })
  all(@Query() q: AdminActivityQueryDto) {
    return this.activity.listAll(q);
  }

  @Get('admin/mcp/status')
  @ApiOperation({ summary: 'External AI apps: status (Admin)', description: 'The two kill switches, whether the OAuth server is on, whether APP_URL is a public https address, and how many apps are connected.' })
  @ApiDataResponse(McpStatusResponseDto)
  @Auth({ permissions: ['system_settings:read'] })
  async status(): Promise<McpStatus> {
    const s = await this.settings.read();
    const appUrl = (this.config.get<string>('appUrl') ?? process.env.APP_URL ?? '').replace(/\/+$/, '');
    const oauth = this.oauth ? await this.oauth.read().catch(() => null) : null;
    return {
      externalAppsEnabled: s.externalAppsEnabled,
      patMcpEnabled: s.patMcpEnabled,
      oauthEnabled: oauth?.enabled === true,
      mcpUrl: `${appUrl}${MCP_PATH}`,
      publicHttps: isPublicHttpsUrl(appUrl),
      ...(await grantCounts(this.prisma)),
    };
  }

  @Get('admin/connected-apps')
  @ApiOperation({ summary: "Every user's connected AI apps (Admin)", description: 'The active OAuth grants of every user: app, user, scopes, last use and runs in 30 days. Disconnect with DELETE /admin/connected-apps/grants/:grantId.' })
  @ApiDataResponse(AdminConnectedAppListResponseDto)
  @Auth({ permissions: ['oauth_clients:read'] })
  async apps(): Promise<AdminConnectedApp[]> {
    const grants = await this.prisma.oAuthGrant.findMany({
      where: { revokedAt: null },
      include: { client: { select: { name: true, host: true } }, user: { select: { id: true, email: true, displayName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    if (grants.length === 0) return [];
    const since = new Date(Date.now() - 30 * DAY_MS);
    const runs = await this.prisma.run.groupBy({ by: ['userId', 'clientId'], where: { clientId: { in: [...new Set(grants.map((g) => g.clientId))] }, createdAt: { gte: since } }, _count: { _all: true } });
    return grants.map((g) => {
      const name = clientLabel(g.client);
      return {
        grantId: g.id,
        clientId: g.clientId,
        name,
        displayName: friendlyAppName(name),
        user: { id: g.user.id, email: g.user.email, displayName: g.user.displayName },
        scopes: scopeViews(g.scopes),
        connectedAt: g.createdAt.toISOString(),
        lastUsedAt: g.lastUsedAt?.toISOString() ?? null,
        runs30d: runs.find((r) => r.userId === g.userId && r.clientId === g.clientId)?._count._all ?? 0,
      };
    });
  }

  @Delete('admin/connected-apps/grants/:grantId')
  @HttpCode(204)
  @ApiOperation({
    summary: "Disconnect a user's AI app (Admin)",
    description: "Revokes the grant and every token of it (`revoked_reason: admin`): the app is signed out on its next call. The platform audits the revocation (`oauth:grant.revoke`, `by: admin`); the user's AI app activity records it too.",
  })
  @Auth({ permissions: ['oauth_clients:write'] })
  async disconnect(@CurrentUser('id') adminId: string, @Param('grantId', ParseUUIDPipe) grantId: string): Promise<void> {
    const grant = await this.prisma.oAuthGrant.findFirst({ where: { id: grantId, revokedAt: null } });
    if (!grant || !this.grants) throw new NotFoundException({ code: 'GRANT_NOT_FOUND', message: 'No active grant with that id' });
    const revoked = await this.grants.revokeGrant({ id: grant.id, userId: grant.userId, orgId: grant.orgId, clientId: grant.clientId, resource: grant.resource }, 'admin', {
      audit: { action: OAUTH_AUDIT_ACTIONS.GRANT_REVOKE, actorUserId: adminId, meta: { clientId: grant.clientId, by: 'admin' } },
    });
    if (!revoked) throw new NotFoundException({ code: 'GRANT_NOT_FOUND', message: 'No active grant with that id' });
    await this.activity.record({ userId: grant.userId, orgId: grant.orgId, event: 'admin_disconnect', credentialKind: 'jwt', clientId: grant.clientId, grantId: grant.id, outcome: 'ok', detail: { by: 'admin' } });
  }
}
