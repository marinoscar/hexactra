import { Module } from '@nestjs/common';

import { McpController } from './mcp.controller';

/** The console as an MCP server (`POST /api/mcp`). */
@Module({ controllers: [McpController] })
export class McpModule {}
