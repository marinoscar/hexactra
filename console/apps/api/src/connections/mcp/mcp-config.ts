// The `config` JSON of an MCP connection (E39.9, #606): what is safe to keep in a column. NEVER a secret: a bearer token or header value,
// an OAuth client secret and the OAuth tokens are in the credential store (purpose `connection_mcp_secret`, and `connection_token`).
import { z } from 'zod';

import { MCP_AUTH_KINDS, MCP_RESERVED_HEADERS } from './mcp.constants';

export const headerName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9-]+$/, 'A header name: letters, digits and hyphens')
  .refine((h) => !(MCP_RESERVED_HEADERS as readonly string[]).includes(h.toLowerCase()), 'That header is set by Hexactra');

export const mcpOAuthMetaSchema = z.object({
  issuer: z.string().max(2000),
  authorizationEndpoint: z.string().max(2000),
  tokenEndpoint: z.string().max(2000),
  revocationEndpoint: z.string().max(2000).nullable(),
  issuerInResponse: z.boolean(),
  /** The canonical URL of the MCP server: sent as the `resource` of every authorization and token request (RFC 8707). */
  resource: z.string().max(2000),
});
export type McpOAuthMeta = z.infer<typeof mcpOAuthMetaSchema>;

export const mcpConfigSchema = z
  .object({
    url: z.string().max(2000),
    auth: z.object({ kind: z.enum(MCP_AUTH_KINDS), header: headerName.optional() }).strict(),
    server: z.object({ name: z.string().max(200).nullable(), version: z.string().max(100).nullable(), instructions: z.string().max(300).nullable().optional() }).optional(),
    protocolVersion: z.string().max(20).nullable().optional(),
    toolsFetchedAt: z.string().max(40).nullable().optional(),
    oauth: mcpOAuthMetaSchema.optional(),
  })
  .strict();
export type McpConfig = z.infer<typeof mcpConfigSchema>;

/** The config of a connection row, or null when the row is not an MCP connection or its config is not valid. */
export function readMcpConfig(value: unknown): McpConfig | null {
  const parsed = mcpConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
