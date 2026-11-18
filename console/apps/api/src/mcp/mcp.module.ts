import { Module } from '@nestjs/common';

import { FabricModule } from '../fabric/fabric.module';
import { QuestionsModule } from '../questions/questions.module';
import { TasksModule } from '../tasks/tasks.module';
import { McpActivityPurgeHandler, McpActivityPurgeTask } from './mcp-activity.jobs';
import { McpAdminController } from './mcp-admin.controller';
import { McpController } from './mcp.controller';
import { McpDispatcher } from './mcp.dispatcher';
import { McpEndpointCheck, McpExposureCheck, McpHighRiskGrantsCheck, McpKillSwitchCheck, McpPublicReachabilityCheck } from './mcp.doctor-checks';

/**
 * The console as an MCP server (`POST /api/mcp`). The run and question events
 * wake `run_wait` (#463). The audit trail, its retention job, the
 * administration of external AI apps and their Doctor checks (#465); the
 * settings reader, the rate limiter and the activity service are the global
 * `McpSecurityModule`'s.
 */
@Module({
  imports: [TasksModule, QuestionsModule, FabricModule],
  controllers: [McpController, McpAdminController],
  providers: [McpDispatcher, McpActivityPurgeHandler, McpActivityPurgeTask, McpEndpointCheck, McpPublicReachabilityCheck, McpExposureCheck, McpKillSwitchCheck, McpHighRiskGrantsCheck],
})
export class McpModule {}
