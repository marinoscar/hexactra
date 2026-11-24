import { Module } from '@nestjs/common';

import { FabricModule } from '../fabric/fabric.module';
import { KgraphModule } from '../kgraph/kgraph.module';
import { QuestionsModule } from '../questions/questions.module';
import { TasksModule } from '../tasks/tasks.module';
import { McpActivityPurgeHandler, McpActivityPurgeTask } from './mcp-activity.jobs';
import { McpAdminController } from './mcp-admin.controller';
import { McpController } from './mcp.controller';
import { McpDispatcher } from './mcp.dispatcher';
import { McpScopeAvailabilityBinder } from './mcp.scope-availability.binder';
import { McpEndpointCheck, McpExposureCheck, McpHighRiskGrantsCheck, McpKillSwitchCheck, McpPublicReachabilityCheck, McpTrustProxyCheck } from './mcp.doctor-checks';

/**
 * The console as an MCP server (`POST /api/mcp`). The run and question events
 * wake `run_wait` (#463). The audit trail, its retention job, the
 * administration of external AI apps and their Doctor checks (#465); the
 * settings reader, the rate limiter and the activity service are the global
 * `McpSecurityModule`'s. The Knowledge Graph's switches decide whether the
 * learned-procedure tools are offered (E46.22).
 */
@Module({
  imports: [TasksModule, QuestionsModule, FabricModule, KgraphModule],
  controllers: [McpController, McpAdminController],
  providers: [McpScopeAvailabilityBinder, McpDispatcher, McpActivityPurgeHandler, McpActivityPurgeTask, McpEndpointCheck, McpPublicReachabilityCheck, McpExposureCheck, McpKillSwitchCheck, McpHighRiskGrantsCheck, McpTrustProxyCheck],
})
export class McpModule {}
