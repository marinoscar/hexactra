// Request and response shapes of `/api/secrets` (E37.2, #591). Responses describe what the services return; none has
// a field that can hold a token, a client secret, a verifier or a message from Vault.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const vaultAddress = z.string().trim().min(1).max(2048).describe('The Vault address, `https://vault.example.test` (the Vault\'s own `APP_URL`).');

export const saveVaultClientSchema = z
  .object({
    baseUrl: vaultAddress,
    clientId: z.string().trim().min(1).max(200).describe('The OAuth client id the Vault gave Hexactra.'),
    clientSecret: z.string().min(1).max(500).optional().describe('The client secret. Write-only; omit it to keep the stored one.'),
  })
  .strict();
export class SaveVaultClientDto extends createZodDto(saveVaultClientSchema) {}

export const connectVaultSchema = z
  .object({
    allowWrite: z.boolean().optional().describe('Also ask for `vault:items_write` (the agent may save and change logins). A new consent. Off by default.'),
    allowCards: z.boolean().optional().describe('Also ask for `vault:cards_read` and `vault:cards_fill` (the agent may pay with a saved card under your per-merchant permission in the provider and your approval here, without ever seeing a number, an expiry or a code). A new consent. Off by default.'),
    allowIdentity: z.boolean().optional().describe('Also ask for `vault:identity_read` and `vault:identity_fill` (the agent may fill identity details such as a date of birth or an ID number, without ever seeing them). A new consent. Off by default.'),
    returnTo: z.string().max(200).optional().describe('A path on this console to return to after the consent (default `/settings/secrets`).'),
  })
  .strict();
export class ConnectVaultDto extends createZodDto(connectVaultSchema) {}

export const disconnectVaultSchema = z.object({ forgetClient: z.boolean().optional().describe('Also forget your own Vault address, client id and client secret.') }).strict();
export class DisconnectVaultDto extends createZodDto(disconnectVaultSchema) {}

export const callbackQuerySchema = z.object({
  code: z.string().max(4096).optional(),
  state: z.string().max(200).optional(),
  error: z.string().max(100).optional(),
  error_description: z.string().max(1000).optional(),
  iss: z.string().max(2048).optional(),
});
export class CallbackQueryDto extends createZodDto(callbackQuerySchema) {}

export const defaultVaultClientSchema = z
  .object({
    baseUrl: vaultAddress.nullable().optional().describe('The deployment default Vault address. `null` clears it.'),
    clientId: z.string().trim().min(1).max(200).nullable().optional().describe('The default OAuth client id. `null` clears it.'),
    clientSecret: z.string().min(1).max(500).optional().describe('The default client secret. Write-only; omit it to keep the stored one.'),
  })
  .strict();
export class DefaultVaultClientDto extends createZodDto(defaultVaultClientSchema) {}

const iso = z.string().describe('ISO 8601 timestamp');

export const vaultStatusSchema = z.object({
  provider: z.literal('vault'),
  status: z.enum(['not_configured', 'disconnected', 'connected', 'needs_reconnect']).describe('`not_configured`: no address, client id and secret yet. `needs_reconnect`: Vault refused the saved grant; connect again.'),
  configured: z.boolean().describe('The address, client id and client secret are all set (the owner\'s own or the deployment default).'),
  source: z.enum(['user', 'deployment', 'none']).describe('Whose address and client id are used.'),
  baseUrl: z.string().nullable(),
  clientId: z.string().nullable(),
  hasClientSecret: z.boolean().describe('A client secret is stored (never returned).'),
  redirectUri: z.string().describe('The redirect URI the Vault must have registered for this client.'),
  scopes: z.array(z.string()).describe('The scopes you consented to.'),
  vaultUserId: z.string().nullable(),
  agentAccess: z.enum(['on', 'off', 'unknown']).describe("Whether Vault's own agent access switch is on: from `whoami` or the last 403 `AGENT_ACCESS_DISABLED`."),
  connectedAt: iso.nullable(),
  lastUsedAt: iso.nullable(),
  lastSuccessAt: iso.nullable().describe('The last successful call (the connection itself, or a lookup or release by the agent).'),
  lastErrorCode: z.string().nullable().describe('A stable code, never a message.'),
  connecting: z.boolean().describe('A connection was started and its callback has not arrived.'),
});

export const secretsStatusSchema = z.object({
  agentUse: z.object({
    deployment: z.boolean().describe('`secrets.agentUse.enabled` in the system settings (the administrator\'s kill switch, off by default).'),
    user: z.boolean().describe('Your own switch (off by default).'),
    effective: z.boolean().describe('Both are on: the agent may look up and use your saved secrets. With either off, nothing is released, whatever Vault allows.'),
  }),
  providers: z.object({ vault: vaultStatusSchema }),
});
export class SecretsStatusResponseDto extends createZodDto(secretsStatusSchema) {}

export const connectResponseSchema = z.object({
  authorizeUrl: z.string().describe("Send the browser here: Vault's consent screen. The flow is bound to this browser by an HttpOnly cookie set on this response."),
  expiresAt: iso.describe('The flow must finish by then (10 minutes).'),
});
export class ConnectVaultResponseDto extends createZodDto(connectResponseSchema) {}

export const disconnectResponseSchema = z.object({
  revoked: z.boolean().describe('Vault confirmed the revocation. `false`: it could not be asked; remove the app in Vault\'s Connected apps. The tokens here are deleted either way.'),
  status: secretsStatusSchema,
});
export class DisconnectVaultResponseDto extends createZodDto(disconnectResponseSchema) {}

export const defaultVaultClientViewSchema = z.object({
  baseUrl: z.string().nullable(),
  clientId: z.string().nullable(),
  hasClientSecret: z.boolean(),
  allowedHosts: z.array(z.string()),
  redirectUri: z.string().describe('The redirect URI to register at the Vault for this client.'),
});
export class DefaultVaultClientViewResponseDto extends createZodDto(defaultVaultClientViewSchema) {}
