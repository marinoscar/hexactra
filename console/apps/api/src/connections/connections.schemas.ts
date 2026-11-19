// Request and response shapes of `/api/connections` (E39.2, #599). Responses describe what the services return; none has a field
// that can hold a token, a scope string, a verifier or a message from a provider.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { MATRIX_COLUMNS } from './capability-matrix';
import { CAPABILITIES, CAPABILITY_GROUPS, CONNECTION_PROVIDER_IDS, MAX_LABEL_LENGTH } from './connections.constants';

const capability = z.enum(CAPABILITIES);
const group = z.enum(CAPABILITY_GROUPS);
const provider = z.enum(CONNECTION_PROVIDER_IDS);
const label = z
  .string()
  .trim()
  .min(1)
  .max(MAX_LABEL_LENGTH)
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'No control characters');
const returnTo = z.string().max(200).optional().describe('A path on this console to return to after the consent (default `/settings/connections`).');
const iso = z.string().describe('ISO 8601 timestamp');

export const authorizeSchema = z
  .object({
    provider: provider.describe('`google` or `microsoft`.'),
    capabilities: z.array(capability).min(1).max(CAPABILITIES.length).describe('What the account may be used for. A write capability brings its read capability.'),
    label: label.optional().describe('What you call it ("Work", "Personal"). Defaults to the provider and the account.'),
    loginHint: z.string().trim().min(3).max(320).optional().describe('The account to pre-select at the provider (the email). Connecting the same account again updates its connection.'),
    returnTo,
  })
  .strict();
export class AuthorizeConnectionDto extends createZodDto(authorizeSchema) {}

export const updateConnectionSchema = z
  .object({
    label: label.optional(),
    capabilities: z.array(capability).max(CAPABILITIES.length).optional().describe('The full set of switches. Turning one off is immediate; adding one the provider has not granted starts an incremental consent (`consent.authorizeUrl`).'),
    defaultFor: z.array(group).max(CAPABILITY_GROUPS.length).optional().describe('The groups (`mail`, `calendar`, `docs`) this account is the default for. At most one default per provider and group: it is taken from the other account.'),
    returnTo,
  })
  .strict();
export class UpdateConnectionDto extends createZodDto(updateConnectionSchema) {}

export const connectionIdParamSchema = z.object({ id: z.string().uuid() });
export class ConnectionIdParamDto extends createZodDto(connectionIdParamSchema) {}

export const callbackParamSchema = z.object({ provider: z.string().max(20) });
export class CallbackParamDto extends createZodDto(callbackParamSchema) {}

export const callbackQuerySchema = z.object({
  code: z.string().max(4096).optional(),
  state: z.string().max(200).optional(),
  error: z.string().max(100).optional(),
  error_description: z.string().max(1000).optional(),
  iss: z.string().max(2048).optional(),
  scope: z.string().max(4096).optional(),
  authuser: z.string().max(20).optional(),
  prompt: z.string().max(100).optional(),
  hd: z.string().max(255).optional(),
  session_state: z.string().max(500).optional(),
  client_info: z.string().max(2000).optional(),
});
export class CallbackQueryDto extends createZodDto(callbackQuerySchema) {}

export const connectionViewSchema = z.object({
  id: z.string().uuid(),
  provider: z.enum(['google', 'microsoft', 'mcp']),
  label: z.string(),
  accountEmail: z.string(),
  accountName: z.string().nullable(),
  capabilities: z.array(capability).describe('The switches that are on.'),
  granted: z.array(capability).describe('What the provider granted. Switching one of these on needs no new consent; a permission stays granted at the provider until the account is disconnected.'),
  defaultFor: z.array(group),
  status: z.enum(['active', 'paused', 'needs_reconnect', 'revoked']),
  statusReason: z.string().nullable().describe('A stable code (`GRANT_REVOKED`, ...), never a message.'),
  connectedAt: iso,
  lastUsedAt: iso.nullable(),
  lastRefreshAt: iso.nullable(),
});
export class ConnectionResponseDto extends createZodDto(connectionViewSchema) {}

const usageSchema = z.object({ kind: z.string(), id: z.string(), name: z.string() });
export const connectionDetailSchema = connectionViewSchema.extend({ usedBy: z.array(usageSchema).describe('What uses this connection (tasks, deliveries): removing it clears these and they show "connection removed".') });
export class ConnectionDetailResponseDto extends createZodDto(connectionDetailSchema) {}

export const consentSchema = z.object({
  authorizeUrl: z.string().describe("Send the browser here: the provider's consent screen. The flow is bound to this browser by an HttpOnly cookie set on this response."),
  expiresAt: iso.describe('The flow must finish by then (10 minutes).'),
});
export class AuthorizeResponseDto extends createZodDto(consentSchema) {}

export const updateResultSchema = z.object({ connection: connectionViewSchema, consent: consentSchema.nullable() });
export class UpdateConnectionResponseDto extends createZodDto(updateResultSchema) {}

export const testResultSchema = z.object({
  results: z.array(z.object({ capability: capability, ok: z.boolean(), code: z.string().nullable().describe('A closed reason code when it failed (`UNAUTHORIZED`, `FORBIDDEN`, `UNAVAILABLE`, ...).') })),
});
export class TestConnectionResponseDto extends createZodDto(testResultSchema) {}

export const removeResultSchema = z.object({
  revoked: z.boolean().describe('The provider confirmed the revocation. `false`: it could not be asked; remove the app in the provider\'s account settings. The tokens here are deleted either way.'),
  clearedReferences: z.number().int().describe('How many tasks or deliveries referenced it and now show "connection removed".'),
});
export class RemoveConnectionResponseDto extends createZodDto(removeResultSchema) {}

const accountTypeSchema = z.object({ id: z.string(), label: z.string(), supported: z.boolean(), note: z.string() });
export const providerAvailabilitySchema = z.object({
  provider: provider,
  displayName: z.string(),
  ready: z.boolean().describe('The provider can be connected now.'),
  reason: z.enum(['not_installed', 'disabled', 'not_configured']).nullable().describe('Why not: the code is not installed, the administrator switched it off, or the setup is unfinished.'),
  accountTypes: z.array(accountTypeSchema).describe('Which kinds of account work, and what to know before starting.'),
  matrixColumns: z.array(z.enum(MATRIX_COLUMNS)).describe('The kinds of account the capability matrix distinguishes at this provider.'),
  capabilityMatrix: z
    .array(
      z.object({
        method: z.string().describe('`mail.search`, `calendar.createEvent`, `documents.appendRows`, ...'),
        service: z.enum(['mail', 'calendar', 'documents']),
        effect: z.enum(['read', 'write']),
        capability: capability.describe('The switch the method needs.'),
        support: z.record(z.string(), z.object({ support: z.enum(['supported', 'limited', 'unsupported']), note: z.string().optional() })).describe('Per matrix column: whether the method works, and how it is limited or why it is not supported.'),
      }),
    )
    .describe('What each kind of account can do, per method. A method marked `unsupported` fails with `NOT_SUPPORTED`; do not offer it.'),
  adminConsentUrl: z.string().nullable().describe('Microsoft: the address an administrator of the owner\'s organization opens to approve the app for everyone. Null elsewhere.'),
});
export class ProviderAvailabilityResponseDto extends createZodDto(providerAvailabilitySchema) {}

// ---- the administrator's apps ----

export const saveAppSchema = z
  .object({
    enabled: z.boolean().optional().describe('Whether owners may connect this provider. Off by default.'),
    clientId: z.string().trim().min(1).max(300).nullable().optional().describe('The OAuth client id of the app you registered. `null` clears it.'),
    clientSecret: z.string().min(1).max(1000).optional().describe('The client secret. Write-only; omit it to keep the stored one.'),
    tenant: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9.-]+$/)
      .optional()
      .describe('Microsoft only: `common`, `organizations`, `consumers` or a tenant id.'),
  })
  .strict();
export class SaveConnectionAppDto extends createZodDto(saveAppSchema) {}

export const providerParamSchema = z.object({ provider: provider });
export class ProviderParamDto extends createZodDto(providerParamSchema) {}

export const adminProviderSchema = z.object({
  provider: provider,
  displayName: z.string(),
  enabled: z.boolean(),
  clientId: z.string().nullable(),
  hasClientSecret: z.boolean().describe('A client secret is stored (never returned).'),
  tenant: z.string().nullable(),
  installed: z.boolean().describe('The code for this provider is installed on this deployment.'),
  redirectUri: z.string().describe('The redirect URI to register at the provider for this app.'),
  setupSteps: z.array(z.string()),
  accountTypes: z.array(accountTypeSchema),
});
export class AdminProviderResponseDto extends createZodDto(adminProviderSchema) {}
