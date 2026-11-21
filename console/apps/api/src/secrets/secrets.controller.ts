// `/api/secrets` (E37.2, #591): the owner's connection to their Vault and its status.
//
// NOTHING HERE RETURNS A TOKEN, A CLIENT SECRET OR A LOGIN. The routes configure and connect the provider; looking up
// a login and typing a field is the fabric's job (E37.1, E37.3), never an HTTP route of the console.
import { Body, Controller, Delete, Get, HttpCode, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser, Public } from '@marinoscar/platform-api/identity';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  CallbackQueryDto,
  ConnectVaultDto,
  ConnectVaultResponseDto,
  DefaultVaultClientDto,
  DefaultVaultClientViewResponseDto,
  DisconnectVaultDto,
  DisconnectVaultResponseDto,
  SaveVaultClientDto,
  SecretsStatusResponseDto,
  StoreStateResponseDto,
} from './secrets.schemas';
import { SecretsPolicyService } from './secrets-policy.service';
import { BINDING_COOKIE, CALLBACK_PATH, CONNECT_TTL_MS, VaultConnectionService } from './vault-connection.service';
import { VaultDefaultClientService } from './vault-default-client.service';

const secure = () => (process.env.APP_URL ?? '').startsWith('https://');
const COOKIE_PATH = '/api/secrets/vault';

function bindingCookie(value: string, maxAgeS: number): string {
  return `${BINDING_COOKIE}=${value}; Path=${COOKIE_PATH}; Max-Age=${maxAgeS}; HttpOnly; SameSite=Lax${secure() ? '; Secure' : ''}`;
}

@ApiTags('Secrets')
@Controller('secrets')
export class SecretsController {
  constructor(
    private readonly vault: VaultConnectionService,
    private readonly defaults: VaultDefaultClientService,
    private readonly policy: SecretsPolicyService,
  ) {}

  @Get('status')
  @ApiDataResponse(SecretsStatusResponseDto)
  @Auth({ permissions: ['secrets:read'] })
  @ApiOperation({
    summary: 'Status of your secrets providers',
    description:
      'Whether your Vault is connected (`status`), the scopes you consented to, the last successful call, the last error `code` (a stable code, never a message), whether Vault\'s own agent access switch is on (`agentAccess`), and the two Hexactra switches (`agentUse`: the deployment\'s and yours, both off by default; both must be on for the agent to look up or use anything). Never a token, a client secret or a login.',
  })
  status(@CurrentUser('id') userId: string) {
    return this.vault.status(userId);
  }

  @Put('vault/client')
  @ApiDataResponse(SecretsStatusResponseDto)
  @ApiResponse({ status: 409, description: '`SECRETS_VAULT_DISCONNECT_FIRST`: the address or client id cannot change while connected.' })
  @ApiResponse({ status: 422, description: '`SECRETS_VAULT_URL_REFUSED`: not https, a private address, or user info in the URL (`details.reason`).' })
  @Auth({ permissions: ['secrets:write'] })
  @ApiOperation({
    summary: 'Set your Vault address, client id and client secret',
    description: 'Your own entries; an administrator may set a deployment default so you only press Connect. The client secret is write-only (omit it to keep the stored one). The address is checked against private-address rules (https only; loopback http in development) and again on every call.',
  })
  saveClient(@CurrentUser('id') userId: string, @Body() body: SaveVaultClientDto) {
    return this.vault.saveClient(userId, body);
  }

  @Post('vault/connect')
  @HttpCode(200)
  @ApiDataResponse(ConnectVaultResponseDto)
  @ApiResponse({ status: 409, description: '`SECRETS_VAULT_NOT_CONFIGURED`: set the address, client id and client secret first.' })
  @ApiResponse({ status: 422, description: '`SECRETS_VAULT_URL_REFUSED`.' })
  @ApiResponse({ status: 502, description: '`SECRETS_VAULT_CONNECT_FAILED`: the Vault did not answer as an OAuth server.' })
  @Auth({ permissions: ['secrets:write'] })
  @ApiOperation({
    summary: "Start connecting your Vault (OAuth 2.1 authorization code with PKCE)",
    description:
      'Returns `authorizeUrl`: send the browser there (Vault\'s own consent screen). The PKCE verifier and `state` are kept on the server and the flow is bound to this browser by an HttpOnly cookie set on this response, so the callback must arrive in the same browser within 10 minutes. Scopes: `vault:items_read vault:items_fill offline_access`; `allowWrite` adds `vault:items_write` and `allowIdentity` adds `vault:identity_read vault:identity_fill` and `allowCards` adds `vault:cards_read vault:cards_fill` (each a new consent). The `resource` indicator is the Vault\'s `/api/agent/v1`.',
  })
  async connect(@CurrentUser('id') userId: string, @Body() body: ConnectVaultDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const r = await this.vault.connect(userId, body);
    reply.header('set-cookie', bindingCookie(r.binding, Math.floor(CONNECT_TTL_MS / 1000)));
    reply.header('cache-control', 'no-store');
    return { authorizeUrl: r.authorizeUrl, expiresAt: r.expiresAt.toISOString() };
  }

  /**
   * Public on purpose: the browser arrives here from Vault without our bearer token. What authenticates the request
   * is the single-use `state` (kept as a hash on the pending connection) AND the HttpOnly binding cookie set by
   * `connect`. It never answers with data: a 302 to the return page with `?vault=connected` or `?vault=<reason>`.
   */
  @Get('vault/callback')
  @Public()
  @ApiResponse({ status: 302, description: 'Back to the page that started the connection (`/settings/secrets` by default) with `vault=connected`, or `vault=<reason>` (`denied`, `expired`, `state_invalid`, `binding_invalid`, `exchange_failed`, ...).' })
  @ApiOperation({ summary: 'Vault redirects the browser here after the consent', description: `The redirect URI to register at the Vault (\`${CALLBACK_PATH}\` under this console's address). Not called by API clients.` })
  async callback(@Query() q: CallbackQueryDto, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const cookies = (req as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies;
    const r = await this.vault.handleCallback({ code: q.code, state: q.state, error: q.error, iss: q.iss }, cookies?.[BINDING_COOKIE]);
    const sep = r.returnTo.includes('?') ? '&' : '?';
    void reply
      .status(302)
      .header('location', `${r.returnTo}${sep}vault=${r.outcome}`)
      .header('set-cookie', bindingCookie('', 0))
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .send();
  }

  @Post('vault/disconnect')
  @HttpCode(200)
  @ApiDataResponse(DisconnectVaultResponseDto)
  @Auth({ permissions: ['secrets:write'] })
  @ApiOperation({
    summary: 'Disconnect your Vault',
    description: 'Revokes the grant at Vault (`revoked: false` when Vault could not be asked: remove the app in its Connected apps), deletes the stored tokens, tells the fabric to forget the provider and marks the connection disconnected. A run that is using it falls back to asking you. `forgetClient` also forgets your own address, client id and client secret.',
  })
  disconnect(@CurrentUser('id') userId: string, @Body() body: DisconnectVaultDto) {
    return this.vault.disconnect(userId, body);
  }

  // ---- the built-in store (#711) ----

  @Get('store/state')
  @ApiDataResponse(StoreStateResponseDto)
  @Auth({ permissions: ['system_settings:read'] })
  @ApiOperation({ summary: 'The built-in secrets store, for the administrator', description: 'Whether the deployment has a store key (and its public id), whether the store is loaded, and whether it is switched on (system setting `secrets.store.enabled`). Never a key.' })
  storeState() {
    return this.policy.storeState();
  }

  // ---- the administrator's default client ----

  @Get('vault/default-client')
  @ApiDataResponse(DefaultVaultClientViewResponseDto)
  @Auth({ permissions: ['system_settings:read'] })
  @ApiOperation({ summary: 'The deployment default Vault client', description: 'Address, client id and whether a client secret is stored (never the secret), plus the redirect URI to register at the Vault.' })
  getDefault() {
    return this.defaults.get();
  }

  @Put('vault/default-client')
  @ApiDataResponse(DefaultVaultClientViewResponseDto)
  @ApiResponse({ status: 422, description: '`SECRETS_VAULT_URL_REFUSED`.' })
  @Auth({ permissions: ['system_settings:write'] })
  @ApiOperation({ summary: 'Set the deployment default Vault client', description: 'So owners only press Connect. The client secret is write-only. An owner\'s own entries take precedence.' })
  setDefault(@CurrentUser('id') adminId: string, @Body() body: DefaultVaultClientDto) {
    return this.defaults.set(adminId, body);
  }

  @Delete('vault/default-client')
  @ApiDataResponse(DefaultVaultClientViewResponseDto)
  @Auth({ permissions: ['system_settings:write'] })
  @ApiOperation({ summary: 'Remove the deployment default Vault client', description: 'Removes the default address, client id and client secret. Existing connections and owners\' own entries are untouched.' })
  removeDefault(@CurrentUser('id') adminId: string) {
    return this.defaults.remove(adminId);
  }
}
