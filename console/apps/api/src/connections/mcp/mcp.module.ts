import { Module } from '@nestjs/common';

import { ConnectionsModule } from '../connections.module';
import { McpAdminController, McpConnectionsController } from './mcp-connections.controller';

/**
 * The routes of MCP servers as connections (E39.9, #606): adding a server, its tools and the administrator's switch. The services are
 * `ConnectionsModule`'s (the connection list, test and removal use them); this module only mounts the controllers, and is mounted LAST
 * in `AppModule` so the generated OpenAPI document keeps the order of everything mounted before it.
 */
@Module({ imports: [ConnectionsModule], controllers: [McpConnectionsController, McpAdminController] })
export class McpConnectionsModule {}
