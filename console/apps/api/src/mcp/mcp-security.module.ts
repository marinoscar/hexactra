import { Global, Module } from '@nestjs/common';
import { OAUTH_RATE_LIMITER } from '@marinoscar/platform-api/identity';

import { PrismaService } from '../prisma/prisma.service';
import { McpActivityService } from './mcp-activity.service';
import { McpSettingsReader } from './mcp-settings.reader';
import { InMemoryMcpRateLimiter, MCP_RATE_LIMITER, McpKillSwitchGuard, McpRateLimitGuard, type McpRateLimiter } from './mcp.rate-limit';
import { McpRateLimitPurgeHandler, McpRateLimitPurgeTask } from './mcp.rate-limit.jobs';
import { PostgresRateLimiter, SharedOAuthRateLimiter, rateLimitStoreFrom } from './mcp.rate-limit.pg';
import { McpMetrics } from './mcp.metrics';

/** The MCP limiter of this deployment: `MCP_RATE_LIMIT_STORE` (read at boot; an unknown value fails it). */
export function mcpRateLimiterFactory(prisma: PrismaService): McpRateLimiter {
  return rateLimitStoreFrom() === 'postgres' ? new PostgresRateLimiter(prisma) : new InMemoryMcpRateLimiter();
}

/**
 * The OAuth server's limiter: the shared store when there is one; otherwise
 * nothing, and the platform keeps its own in-memory limiter
 * (`OAuthRateLimitService` injects the token as optional).
 */
export function oauthRateLimiterFactory(limiter: McpRateLimiter): SharedOAuthRateLimiter | undefined {
  return limiter instanceof PostgresRateLimiter ? new SharedOAuthRateLimiter(limiter) : undefined;
}

/**
 * What keeps the MCP endpoint safe on the public internet (#465): the cached
 * `mcp` settings (kill switches, rate limits, sensitive hosts), the rate
 * limiter, the audit trail. Global: the browser routes (sensitive-action
 * confirmation) and the connected apps (settings changes) read them too.
 *
 * The rate limiter (#517): in this process's memory by default, or a shared
 * Postgres table with `MCP_RATE_LIMIT_STORE=postgres` (several API replicas),
 * which then also backs the platform OAuth server's limits (`OAUTH_RATE_LIMITER`,
 * visible to it because this module is global) and gets its hourly cleanup job.
 */
@Global()
@Module({
  providers: [
    McpSettingsReader,
    McpActivityService,
    McpMetrics,
    McpKillSwitchGuard,
    McpRateLimitGuard,
    { provide: MCP_RATE_LIMITER, inject: [PrismaService], useFactory: mcpRateLimiterFactory },
    { provide: OAUTH_RATE_LIMITER, inject: [MCP_RATE_LIMITER], useFactory: oauthRateLimiterFactory },
    McpRateLimitPurgeHandler,
    McpRateLimitPurgeTask,
  ],
  exports: [McpSettingsReader, McpActivityService, McpMetrics, McpKillSwitchGuard, McpRateLimitGuard, MCP_RATE_LIMITER, OAUTH_RATE_LIMITER],
})
export class McpSecurityModule {}
