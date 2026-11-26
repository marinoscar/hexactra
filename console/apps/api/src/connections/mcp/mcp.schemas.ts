// Request and response shapes of the MCP routes (E39.9, #606). No response has a field that can hold a token, a header value or a message
// from a server: tools carry the server's text only as plain text for the owner to read.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { MAX_LABEL_LENGTH } from '../connections.constants';
import { connectionViewSchema } from '../connections.schemas';
import { headerName } from './mcp-config';
import { MCP_AUTH_KINDS, MCP_TOOL_MODES } from './mcp.constants';

const label = z
  .string()
  .trim()
  .min(1)
  .max(MAX_LABEL_LENGTH)
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'No control characters');
const iso = z.string().describe('ISO 8601 timestamp');

const authSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('bearer'), token: z.string().min(1).max(4000).regex(/^[\x21-\x7e]+$/, 'A token has no spaces or control characters') }).strict(),
  z.object({ kind: z.literal('header'), header: headerName, value: z.string().min(1).max(4000).regex(/^[\x20-\x7e]+$/, 'A header value is plain text') }).strict(),
  z
    .object({
      kind: z.literal('oauth'),
      clientId: z.string().trim().min(1).max(500).nullable().optional().describe('The client id of an app you registered with the server. Leave it out to let Hexactra register itself (dynamic client registration).'),
      clientSecret: z.string().min(1).max(2000).nullable().optional().describe('Write-only. Only for a confidential client you registered.'),
    })
    .strict(),
]);

export const addMcpSchema = z
  .object({
    url: z.string().trim().min(8).max(2000).describe('The server\'s Streamable HTTP endpoint. `https` only; no user name, password, query or fragment.'),
    label: label.optional().describe('What you call it. Defaults to the server\'s host name.'),
    auth: authSchema.describe('How the server signs you in: nothing, a bearer token, a header, or OAuth (a consent at the server\'s own sign-in page). Secrets are stored encrypted and never returned.'),
    returnTo: z.string().max(200).optional().describe('For OAuth: a path on this console to return to (default `/settings/connections`).'),
  })
  .strict();
export class AddMcpDto extends createZodDto(addMcpSchema) {}

export const mcpAuthSchema = z.object({ auth: authSchema, returnTo: z.string().max(200).optional() }).strict();
export class McpAuthDto extends createZodDto(mcpAuthSchema) {}

export const mcpToolSchema = z.object({
  id: z.string().uuid(),
  name: z.string().describe('The server\'s own name for the tool.'),
  title: z.string().nullable(),
  description: z.string().describe('The server\'s description as plain text (markup and control characters removed). It is the server\'s claim, not Hexactra\'s.'),
  parameters: z.array(z.object({ name: z.string(), type: z.string().nullable(), required: z.boolean() })),
  hints: z.object({ readOnly: z.boolean().nullable(), destructive: z.boolean().nullable(), idempotent: z.boolean().nullable(), openWorld: z.boolean().nullable() }).describe('What the server claims about the tool. A hint is not a guarantee.'),
  suggested: z.enum(['read', 'write']).describe('What the hints suggest. A tool with no hints is suggested `write`. Only a suggestion: nothing is on until you switch it on.'),
  mode: z.enum(MCP_TOOL_MODES).describe('Your decision: `off` (default), `read` (called without asking) or `write` (asks you each time unless you chose "Don\'t ask again").'),
  review: z.enum(['new', 'changed']).nullable().describe('Set while the tool is new, or its description, schema or hints changed since you decided: it is off until you decide again.'),
});
export class McpToolResponseDto extends createZodDto(mcpToolSchema) {}

export const mcpCatalogSchema = z.object({ tools: z.array(mcpToolSchema), needsReview: z.number().int(), fetchedAt: iso.nullable() });
export class McpCatalogResponseDto extends createZodDto(mcpCatalogSchema) {}

const consentSchema = z.object({ authorizeUrl: z.string(), expiresAt: iso });

export const addMcpResultSchema = z.object({
  connection: connectionViewSchema.nullable().describe('Null while an OAuth consent is pending: the connection exists once the consent returns.'),
  catalog: mcpCatalogSchema.nullable(),
  consent: consentSchema.nullable().describe('OAuth: send the browser here. The flow is bound to this browser by an HttpOnly cookie set on this response.'),
});
export class AddMcpResponseDto extends createZodDto(addMcpResultSchema) {}

export const mcpAuthResultSchema = z.object({ connection: connectionViewSchema, consent: consentSchema.nullable() });
export class McpAuthResponseDto extends createZodDto(mcpAuthResultSchema) {}

export const toolParamSchema = z.object({ id: z.string().uuid(), toolId: z.string().uuid() });
export class McpToolParamDto extends createZodDto(toolParamSchema) {}

export const setToolModeSchema = z.object({ mode: z.enum(MCP_TOOL_MODES).describe('`off`, `read` (the tool only reads: it is called without asking) or `write` (it changes something: it asks you first).') }).strict();
export class SetToolModeDto extends createZodDto(setToolModeSchema) {}

// ---- presets and trying a tool (E50.12) ----

export const mcpPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().describe('The server\'s address, as its vendor documents it.'),
  auth: z.enum(MCP_AUTH_KINDS).describe('How it signs you in. A preset never carries a secret: you give the token, or sign in at the server.'),
  headerName: z.string().optional().describe('For `header`: the header the server reads its key from.'),
  docsUrl: z.string().describe('The vendor\'s own documentation of the server.'),
  notes: z.string(),
  verified: z.string().describe('The date (`YYYY-MM-DD`) the address was checked against that documentation.'),
});
export class McpPresetResponseDto extends createZodDto(mcpPresetSchema) {}

export const tryToolSchema = z
  .object({ arguments: z.record(z.string(), z.unknown()).default({}).describe("The tool's arguments, checked against its own JSON schema before anything is sent.") })
  .strict()
  .refine((b) => JSON.stringify(b.arguments).length <= 32_000, 'At most 32,000 characters of arguments');
export class TryToolDto extends createZodDto(tryToolSchema) {}

export const tryResultSchema = z.object({
  ok: z.boolean().describe('The server answered and reported no error.'),
  code: z.string().nullable().describe('Null when ok; `TOOL_ERROR` (the server reported an error), `REFUSED` (nothing was sent: the tool or connection changed), or the failure (`TIMEOUT`, `UNAVAILABLE`, `AUTH`, ...).'),
  ms: z.number().int(),
  text: z.string().describe('What a run would read: cleaned, redacted of every credential and capped at 4,000 characters. The server\'s words: show it as plain text.'),
  truncated: z.boolean(),
});
export class TryResultResponseDto extends createZodDto(tryResultSchema) {}

// ---- the administrator ----

const hostPattern = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/, 'A host name such as mcp.example.test or *.example.test');

export const saveMcpAdminSchema = z
  .object({
    enabled: z.boolean().optional().describe('Whether owners may add and use MCP servers. Off by default.'),
    allowedHosts: z.array(hostPattern).max(200).optional().describe('Exact host names or `*.example.test`. Empty: any public host. Replaces the stored list.'),
    blockedHosts: z.array(hostPattern).max(200).optional().describe('Hosts that are never allowed, whatever the allow-list says. Replaces the stored list.'),
  })
  .strict();
export class SaveMcpAdminDto extends createZodDto(saveMcpAdminSchema) {}

export const mcpAdminSchema = z.object({ enabled: z.boolean(), allowedHosts: z.array(z.string()), blockedHosts: z.array(z.string()) });
export class McpAdminResponseDto extends createZodDto(mcpAdminSchema) {}

export const mcpStatusSchema = z.object({ enabled: z.boolean().describe('Whether the administrator has switched MCP servers on for this deployment.'), restricted: z.boolean().describe('The administrator limits which hosts may be used.') });
export class ConnectionMcpStatusResponseDto extends createZodDto(mcpStatusSchema) {}
