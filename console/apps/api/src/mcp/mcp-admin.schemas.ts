// Wire shapes of the MCP audit trail and the administration of external AI
// apps (#465), for the OpenAPI document and the SDK.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { appScopeSchema } from '../connected-apps/connected-apps.schemas';
import { MCP_ACTIVITY_EVENTS, MCP_ACTIVITY_OUTCOMES, ACTIVITY_PAGE_MAX } from './mcp-activity.service';

const uuid = z.uuid();

export const activityQuerySchema = z.object({
  clientId: uuid.optional().describe('Only this OAuth app (`oauth_clients.id`)'),
  tool: z.string().max(64).optional().describe('Only this tool, e.g. browser_click'),
  effect: z.enum(['read', 'write', 'destructive']).optional(),
  outcome: z.enum(MCP_ACTIVITY_OUTCOMES).optional(),
  credentialKind: z.enum(['oauth', 'pat', 'jwt']).optional().describe('`oauth`: apps signed in with OAuth; `pat`: personal access tokens'),
  limit: z.coerce.number().int().min(1).max(ACTIVITY_PAGE_MAX).optional().describe(`Rows per page (default 50, at most ${ACTIVITY_PAGE_MAX})`),
  cursor: uuid.optional().describe('`nextCursor` of the previous page'),
});
export class ActivityQueryDto extends createZodDto(activityQuerySchema) {}

export const adminActivityQuerySchema = activityQuerySchema.extend({ userId: uuid.optional().describe('Only this user') });
export class AdminActivityQueryDto extends createZodDto(adminActivityQuerySchema) {}

export const activityRowSchema = z.object({
  id: z.uuid(),
  createdAt: z.string(),
  userId: z.uuid(),
  event: z.enum(MCP_ACTIVITY_EVENTS).or(z.string()).describe('tool_call, step_up, rate_limited, kill_switch, app_settings, admin_disconnect'),
  credentialKind: z.string().describe('oauth, pat, or jwt (a change made in the console)'),
  clientId: z.string().nullable(),
  clientName: z.string().nullable().describe('The app; for a personal access token the name its MCP client gave (self-asserted)'),
  tool: z.string().nullable(),
  effect: z.string().nullable(),
  runId: z.string().nullable(),
  taskId: z.string().nullable(),
  sessionId: z.string().nullable(),
  questionId: z.string().nullable(),
  outcome: z.enum(MCP_ACTIVITY_OUTCOMES).or(z.string()),
  errorCode: z.string().nullable(),
  durationMs: z.number().int(),
  requestId: z.string().nullable(),
  detail: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe('Sanitized: the goal\'s first 200 characters, a URL\'s host, a click\'s selector, a script\'s sha256 and length; never typed text, a script or a result'),
});
export const activityPageSchema = z.object({ items: z.array(activityRowSchema), nextCursor: z.string().nullable() });
export class ActivityPageResponseDto extends createZodDto(activityPageSchema) {}

export const mcpStatusSchema = z.object({
  externalAppsEnabled: z.boolean().describe('The kill switch of apps signed in with OAuth (`mcp.externalAppsEnabled`)'),
  patMcpEnabled: z.boolean().describe('The switch of personal access tokens over MCP (`mcp.patMcpEnabled`)'),
  oauthEnabled: z.boolean().describe('Whether the OAuth server is on (Administration → OAuth clients)'),
  mcpUrl: z.string().describe('`<APP_URL>/api/mcp`'),
  publicHttps: z.boolean().describe('Whether APP_URL is an https:// address on a public host name (not loopback, not a private address)'),
  connectedApps: z.number().int().describe('Active OAuth grants to the MCP endpoint, every user'),
  connectedUsers: z.number().int(),
  highRiskGrants: z.number().int().describe('Active grants holding browser:evaluate, desktop:control or policies:write'),
});
export type McpStatus = z.infer<typeof mcpStatusSchema>;
export class McpStatusResponseDto extends createZodDto(mcpStatusSchema) {}

export const adminConnectedAppSchema = z.object({
  grantId: z.uuid().describe('What Disconnect revokes'),
  clientId: z.uuid(),
  name: z.string().describe('The client\'s host, or its own name for a local app'),
  displayName: z.string(),
  user: z.object({ id: z.uuid(), email: z.string(), displayName: z.string().nullable() }),
  scopes: z.array(appScopeSchema),
  connectedAt: z.string(),
  lastUsedAt: z.string().nullable(),
  runs30d: z.number().int(),
});
export class AdminConnectedAppListResponseDto extends createZodDto(z.array(adminConnectedAppSchema)) {}
export type AdminConnectedApp = z.infer<typeof adminConnectedAppSchema>;
