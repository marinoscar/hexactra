// The administrator's default Vault client (E37.2, #591): a Vault address and OAuth client id in the system settings
// (`secrets.vault`) and the client secret in the deployment's credential store (purpose `secrets_vault_client`),
// so an owner only has to press Connect. An owner's own entries take precedence.
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { CredentialsService } from '@marinoscar/platform-api/credentials';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { OutboundHttp, OutboundHttpError, normalizeBaseUrl } from '../oauth-client';
import { SecretsPolicyService } from './secrets-policy.service';
import { SECRETS_AUDIT, SecretsEvents, hostOf } from './secrets.events';
import { SECRETS_VAULT_CLIENT_PURPOSE, VAULT_CLIENT_SECRET_NAME } from './secrets.credentials';
import { CALLBACK_PATH } from './vault-connection.service';
import { ConfigService } from '@nestjs/config';

export interface DefaultVaultClientView {
  baseUrl: string | null;
  clientId: string | null;
  hasClientSecret: boolean;
  allowedHosts: string[];
  redirectUri: string;
}

@Injectable()
export class VaultDefaultClientService {
  constructor(
    private readonly settings: SystemSettingsService,
    private readonly credentials: CredentialsService,
    private readonly policy: SecretsPolicyService,
    private readonly http: OutboundHttp,
    private readonly events: SecretsEvents,
    private readonly config: ConfigService,
  ) {}

  async get(): Promise<DefaultVaultClientView> {
    this.policy.invalidate();
    const system = await this.policy.system();
    return {
      baseUrl: system.vault.baseUrl,
      clientId: system.vault.clientId,
      hasClientSecret: (await this.credentials.describe(SECRETS_VAULT_CLIENT_PURPOSE, VAULT_CLIENT_SECRET_NAME)) !== null,
      allowedHosts: system.vault.allowedHosts,
      redirectUri: `${(this.config.get<string>('appUrl') ?? process.env.APP_URL ?? 'http://localhost:3535').replace(/\/+$/, '')}${CALLBACK_PATH}`,
    };
  }

  async set(adminId: string, input: { baseUrl?: string | null; clientId?: string | null; clientSecret?: string }): Promise<DefaultVaultClientView> {
    const vault: Record<string, string | null> = {};
    if (input.baseUrl !== undefined) {
      if (input.baseUrl === null) vault.baseUrl = null;
      else {
        let normalized: string;
        try {
          normalized = normalizeBaseUrl(input.baseUrl);
          await this.http.check(normalized, (await this.policy.system()).vault.allowedHosts);
        } catch (e) {
          throw new HttpException({ code: 'SECRETS_VAULT_URL_REFUSED', message: 'This Vault address is not allowed.', details: { reason: e instanceof OutboundHttpError ? e.code : 'invalid_url' } }, HttpStatus.UNPROCESSABLE_ENTITY);
        }
        vault.baseUrl = normalized;
      }
    }
    if (input.clientId !== undefined) vault.clientId = input.clientId;
    if (Object.keys(vault).length > 0) await this.settings.patchSettings({ secrets: { vault } } as never, adminId);
    if (input.clientSecret) await this.credentials.setSecret(SECRETS_VAULT_CLIENT_PURPOSE, VAULT_CLIENT_SECRET_NAME, input.clientSecret);
    this.policy.invalidate();
    const view = await this.get();
    await this.events.audit(adminId, SECRETS_AUDIT.defaultClientSaved, adminId, { provider: 'vault', host: hostOf(view.baseUrl), secretSet: Boolean(input.clientSecret) });
    return view;
  }

  /** Removes the default address, client id and client secret. An owner's own entries are untouched. */
  async remove(adminId: string): Promise<DefaultVaultClientView> {
    await this.settings.patchSettings({ secrets: { vault: { baseUrl: null, clientId: null } } } as never, adminId);
    await this.credentials.deleteSecret(SECRETS_VAULT_CLIENT_PURPOSE, VAULT_CLIENT_SECRET_NAME);
    this.policy.invalidate();
    await this.events.audit(adminId, SECRETS_AUDIT.defaultClientRemoved, adminId, { provider: 'vault' });
    return this.get();
  }
}
