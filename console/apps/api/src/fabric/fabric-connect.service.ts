import { Injectable } from '@nestjs/common';
import { CredentialsService } from '@marinoscar/platform-api/credentials';

import { FabricClient } from './fabric.client';
import { FABRIC_CREDENTIAL_PURPOSE, FABRIC_TOKEN_NAME, FABRIC_URL_NAME } from './fabric.credentials';

const PURPOSE = FABRIC_CREDENTIAL_PURPOSE.purpose;

/** The fabric bundled with the console's stack (infra/compose/app.fabric.compose.yml). */
export const BUNDLED_FABRIC_URL = 'http://fabric-control:8787';

/** Where the console stands with its fabric connection. Never carries the token. */
export interface FabricConnectStatus {
  /** `missing`: no URL or token stored; `broken`: stored, but the fabric refuses or cannot be reached. */
  state: 'connected' | 'missing' | 'broken';
  url: string | null;
  /** The stored token's hint (its last characters), never the value. */
  tokenHint: string | null;
  /** Why it is broken, when it is. */
  error: string | null;
}

/**
 * The fabric connection as the deploy sees it (issue #309): `hexactra deploy`
 * asks for the status and, when the console is not connected to its bundled
 * fabric, stores a freshly minted service token. Runs inside the api
 * container through `dist/fabric/fabric-connect.cli.js`; the HTTP routes keep
 * using the same credential purpose.
 */
@Injectable()
export class FabricConnectService {
  constructor(
    private readonly credentials: CredentialsService,
    private readonly fabric: FabricClient,
  ) {}

  async status(): Promise<FabricConnectStatus> {
    const [url, token] = await Promise.all([
      this.credentials.getSecret(PURPOSE, FABRIC_URL_NAME),
      this.credentials.describe(PURPOSE, FABRIC_TOKEN_NAME),
    ]);
    if (!url || !token) return { state: 'missing', url: url ?? null, tokenHint: token?.hint ?? null, error: null };
    this.fabric.invalidate();
    try {
      await this.fabric.health();
      await this.fabric.hosts(); // authenticated
      return { state: 'connected', url, tokenHint: token.hint, error: null };
    } catch (e) {
      return { state: 'broken', url, tokenHint: token.hint, error: e instanceof Error ? e.message : 'Unexpected error' };
    }
  }

  /** Stores the URL and service token, then reports the resulting status. */
  async connect(url: string, token: string): Promise<FabricConnectStatus> {
    const base = url.replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/.test(base)) throw new Error(`Not a fabric URL: ${JSON.stringify(url)}`);
    if (!/^hxs_[A-Za-z0-9_-]{8,}$/.test(token)) throw new Error('The token is not an hxs_ service token.');
    await this.credentials.setSecret(PURPOSE, FABRIC_URL_NAME, base, { label: 'Fabric URL' });
    await this.credentials.setSecret(PURPOSE, FABRIC_TOKEN_NAME, token, { label: 'Fabric service token' });
    this.fabric.invalidate();
    return this.status();
  }
}
