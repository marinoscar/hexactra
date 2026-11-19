// Where an MCP connection's secrets live (E39.9, #606): the encrypted per-user credential store, never a column, a step, a log, a span,
// an export or a model's context. Plaintext leaves these methods only for server code at the moment of a request to that server.
import { Injectable } from '@nestjs/common';
import { UserCredentialsService } from '@marinoscar/platform-api/credentials';
import { z } from 'zod';

import { CONNECTION_MCP_SECRET_PURPOSE, mcpClientName, mcpFlowName, mcpSecretName } from '../connections.credentials';
import { mcpOAuthMetaSchema } from './mcp-config';

/** The OAuth client a server signs in with: registered dynamically, or supplied by the owner. */
export const mcpClientSchema = z.object({ clientId: z.string().min(1).max(500), clientSecret: z.string().max(2000).nullable().optional() });
export type McpOAuthClient = z.infer<typeof mcpClientSchema>;

/** What an OAuth Connect in progress needs at its callback (the PKCE verifier is kept as for every connection, purpose `connection_token`). */
export const mcpFlowSchema = z.object({
  url: z.string().max(2000),
  oauth: mcpOAuthMetaSchema,
  client: mcpClientSchema,
  redirectUri: z.string().max(2000),
  /** The connection this reconnects, if any. */
  connectionId: z.string().uuid().nullable(),
});
export type McpFlowContext = z.infer<typeof mcpFlowSchema>;

@Injectable()
export class McpSecretStore {
  constructor(private readonly users: UserCredentialsService) {}

  secret(userId: string, connectionId: string): Promise<string | null> {
    return this.users.getSecret(userId, CONNECTION_MCP_SECRET_PURPOSE, mcpSecretName(connectionId));
  }

  setSecret(userId: string, connectionId: string, value: string): Promise<void> {
    return this.users.setSecret(userId, CONNECTION_MCP_SECRET_PURPOSE, mcpSecretName(connectionId), value);
  }

  async client(userId: string, connectionId: string): Promise<McpOAuthClient | null> {
    return this.json(userId, mcpClientName(connectionId), mcpClientSchema);
  }

  setClient(userId: string, connectionId: string, client: McpOAuthClient): Promise<void> {
    return this.users.setSecret(userId, CONNECTION_MCP_SECRET_PURPOSE, mcpClientName(connectionId), JSON.stringify(client));
  }

  flow(userId: string, flowId: string): Promise<McpFlowContext | null> {
    return this.json(userId, mcpFlowName(flowId), mcpFlowSchema);
  }

  setFlow(userId: string, flowId: string, ctx: McpFlowContext): Promise<void> {
    return this.users.setSecret(userId, CONNECTION_MCP_SECRET_PURPOSE, mcpFlowName(flowId), JSON.stringify(ctx));
  }

  async clearFlow(userId: string, flowId: string): Promise<void> {
    await this.users.deleteSecret(userId, CONNECTION_MCP_SECRET_PURPOSE, mcpFlowName(flowId));
  }

  /** Deletes everything kept for a connection. Idempotent. */
  async clear(userId: string, connectionId: string): Promise<void> {
    await this.users.deleteSecret(userId, CONNECTION_MCP_SECRET_PURPOSE, mcpSecretName(connectionId));
    await this.users.deleteSecret(userId, CONNECTION_MCP_SECRET_PURPOSE, mcpClientName(connectionId));
  }

  private async json<T>(userId: string, name: string, schema: z.ZodType<T>): Promise<T | null> {
    const raw = await this.users.getSecret(userId, CONNECTION_MCP_SECRET_PURPOSE, name);
    if (!raw) return null;
    try {
      const parsed = schema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
