// The console's one call to Vault's agent API: `GET /whoami` (E37.2, #591), made right after the owner consents
// to prove the token works, learn which scopes it holds and whether Vault's own agent access switch is on.
// Everything else (lookup, fill, one-time code) is the fabric's. No body or header is logged; the token is
// sent only in `Authorization` and never appears in an error.
import { Injectable } from '@nestjs/common';

import { OutboundHttp, OutboundHttpError } from '../oauth-client';
import { VAULT_AGENT_API_PATH, VAULT_ERROR_CODES, vaultWhoamiSchema, type VaultWhoami } from './vault-contract';

export type WhoamiResult =
  | { status: 'ok'; whoami: VaultWhoami }
  /** Vault's deployment kill switch is off (`403 AGENT_ACCESS_DISABLED`): the token is fine, nothing can be used yet. */
  | { status: 'agent_access_disabled' }
  /** The token is not accepted (401), or lacks the scope (403 insufficient_scope). */
  | { status: 'unauthorized' }
  | { status: 'unavailable'; code: string };

@Injectable()
export class VaultApiClient {
  constructor(private readonly http: OutboundHttp) {}

  async whoami(baseUrl: string, accessToken: string, allowedHosts: readonly string[] = []): Promise<WhoamiResult> {
    let res;
    try {
      res = await this.http.send({ method: 'GET', url: `${baseUrl.replace(/\/+$/, '')}${VAULT_AGENT_API_PATH}/whoami`, headers: { authorization: `Bearer ${accessToken}` }, allowedHosts, maxBytes: 16 * 1024 });
    } catch (e) {
      return { status: 'unavailable', code: e instanceof OutboundHttpError ? e.code : 'network' };
    }
    if (res.status === 200) {
      let doc: unknown = null;
      try {
        doc = JSON.parse(res.body);
      } catch {
        // not JSON
      }
      const parsed = vaultWhoamiSchema.safeParse(doc);
      return parsed.success ? { status: 'ok', whoami: parsed.data.data } : { status: 'unavailable', code: 'bad_response' };
    }
    if (res.status === 401) return { status: 'unauthorized' };
    if (res.status === 403) {
      let code: unknown;
      try {
        const body = JSON.parse(res.body) as { code?: unknown; error?: { code?: unknown } } | null;
        code = body?.code ?? body?.error?.code;
      } catch {
        // not JSON
      }
      if (code === VAULT_ERROR_CODES.disabled) return { status: 'agent_access_disabled' };
      return { status: 'unauthorized' };
    }
    return { status: 'unavailable', code: `http_${res.status}` };
  }
}
