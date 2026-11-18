import { Global, Module } from '@nestjs/common';

import { McpActivityService } from './mcp-activity.service';
import { McpSettingsReader } from './mcp-settings.reader';
import { InMemoryMcpRateLimiter, MCP_RATE_LIMITER, McpKillSwitchGuard, McpRateLimitGuard } from './mcp.rate-limit';
import { McpMetrics } from './mcp.metrics';

/**
 * What keeps the MCP endpoint safe on the public internet (#465): the cached
 * `mcp` settings (kill switches, rate limits, sensitive hosts), the rate
 * limiter, the audit trail. Global: the browser routes (sensitive-action
 * confirmation) and the connected apps (settings changes) read them too.
 *
 * Several API replicas: bind `MCP_RATE_LIMITER` here to a limiter over a
 * shared store (the in-memory one counts per process).
 */
@Global()
@Module({
  providers: [McpSettingsReader, McpActivityService, McpMetrics, McpKillSwitchGuard, McpRateLimitGuard, { provide: MCP_RATE_LIMITER, useFactory: () => new InMemoryMcpRateLimiter() }],
  exports: [McpSettingsReader, McpActivityService, McpMetrics, McpKillSwitchGuard, McpRateLimitGuard, MCP_RATE_LIMITER],
})
export class McpSecurityModule {}
