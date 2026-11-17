import { Module } from '@nestjs/common';

import { QuestionsModule } from '../questions/questions.module';
import { TasksModule } from '../tasks/tasks.module';
import { McpController } from './mcp.controller';
import { McpDispatcher } from './mcp.dispatcher';
import { McpMetrics } from './mcp.metrics';

/** The console as an MCP server (`POST /api/mcp`). The run and question events wake `run_wait` (#463). */
@Module({ imports: [TasksModule, QuestionsModule], controllers: [McpController], providers: [McpDispatcher, McpMetrics] })
export class McpModule {}
