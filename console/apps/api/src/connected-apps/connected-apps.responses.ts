// The response shapes of `/api/connected-apps` (#464), for the OpenAPI document and the SDK.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { appLimitsSchema, connectedAppSchema } from './connected-apps.schemas';

export class ConnectedAppResponseDto extends createZodDto(connectedAppSchema) {}
export class ConnectedAppListResponseDto extends createZodDto(z.array(connectedAppSchema)) {}
export class AppLimitsResponseDto extends createZodDto(appLimitsSchema) {}

export const PREFLIGHT_CLIENT_IDS = ['chatgpt', 'claude', 'claude-code', 'other'] as const;

export const preflightCheckSchema = z.object({
  id: z.enum(['oauth_enabled', 'public_url', 'well_known']),
  status: z.enum(['pass', 'warn', 'fail', 'skip']),
  title: z.string(),
  detail: z.string(),
  fix: z
    .object({
      who: z.enum(['admin', 'you']).describe('`admin`: the caller can fix it (they hold the permission); `you` never appears here today'),
      path: z.string().nullable().describe('The console page that fixes it, for an administrator'),
      text: z.string().describe('What to do, in a sentence; "Ask your administrator to …" for anyone else'),
    })
    .nullable(),
});

export const appPreflightSchema = z.object({
  mcpUrl: z.string().describe('The URL to paste into the AI app: `<APP_URL>/api/mcp`'),
  admin: z.boolean().describe('Whether the caller may change the OAuth settings (`oauth_clients:write`)'),
  ready: z.boolean().describe('True when no check failed or warned'),
  checks: z.array(preflightCheckSchema),
  clients: z.array(
    z.object({
      id: z.enum(PREFLIGHT_CLIENT_IDS),
      allowed: z.boolean().nullable().describe('Whether the OAuth settings let this app connect; null when it cannot be told in advance (any other client)'),
      hosts: z.array(z.string()),
      detail: z.string(),
    }),
  ),
});
export type AppPreflight = z.infer<typeof appPreflightSchema>;
export class AppPreflightResponseDto extends createZodDto(appPreflightSchema) {}
