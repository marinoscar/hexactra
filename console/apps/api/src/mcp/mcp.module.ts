import { Module } from '@nestjs/common';

import { McpController } from './mcp.controller';
import { McpDispatcher } from './mcp.dispatcher';
import { McpMetrics } from './mcp.metrics';

/** The console as an MCP server (`POST /api/mcp`). */
@Module({ controllers: [McpController], providers: [McpDispatcher, McpMetrics] })
export class McpModule {}
