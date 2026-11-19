// The console's one call to Vault's agent API: `GET /whoami` (E37.2, #591), made right after the owner consents
// to prove the token works, learn which scopes it holds and whether Vault's own agent access switch is on.
// Everything else (lookup, fill, one-time code) is the fabric's. No body or header is logged; the token is
// sent only in `Authorization` and never appears in an error.
import { Injectable } from '@nestjs/common';

import { OutboundHttp, OutboundHttpError } from '../oauth-client';
import { VAULT_AGENT_API_PATH, VAULT_CARD_DISABLED, VAULT_ERROR_CODES, VAULT_IDENTITY_DISABLED, vaultCardsLookupSchema, vaultIdentityLookupSchema, vaultWhoamiSchema, type VaultCardItem, type VaultIdentityItem, type VaultWhoami } from './vault-contract';

export type WhoamiResult =
  | { status: 'ok'; whoami: VaultWhoami }
  /** Vault's deployment kill switch is off (`403 AGENT_ACCESS_DISABLED`): the token is fine, nothing can be used yet. */
  | { status: 'agent_access_disabled' }
  /** The token is not accepted (401), or lacks the scope (403 insufficient_scope). */
  | { status: 'unauthorized' }
  | { status: 'unavailable'; code: string };

export type IdentityListResult =
  | { status: 'ok'; items: VaultIdentityItem[] }
  /** The deployment's identity switch is off in Vault (`403 IDENTITY_ACCESS_DISABLED`). */
  | { status: 'identity_disabled' }
  /** The token is not accepted (401), or lacks an identity scope (403 insufficient_scope). */
  | { status: 'unauthorized' }
  | { status: 'unavailable'; code: string };

export type CardListResult =
  | { status: 'ok'; cards: VaultCardItem[] }
  /** The deployment's card switch is off in Vault (`403 CARD_ACCESS_DISABLED`). */
  | { status: 'cards_disabled' }
  /** The token is not accepted (401), or lacks a card scope (403 insufficient_scope). */
  | { status: 'unauthorized' }
  | { status: 'unavailable'; code: string };

@Injectable()
export class VaultApiClient {
  constructor(private readonly http: OutboundHttp) {}

  /**
   * `GET /identity?origin=` (contract 1.1, scope `vault:identity_read`): the owner's opened identity items with their field
   * labels and flags, to LIST on the Secrets page. `origin` is the Vault's own origin: `originAllowed` and `fillable` are then
   * not about a page and are not used. Never a value (the lookup has none); nothing is logged.
   */
  async identity(baseUrl: string, accessToken: string, allowedHosts: readonly string[] = []): Promise<IdentityListResult> {
    const base = baseUrl.replace(/\/+$/, '');
    let res;
    try {
      res = await this.http.send({ method: 'GET', url: `${base}${VAULT_AGENT_API_PATH}/identity?origin=${encodeURIComponent(new URL(base).origin)}`, headers: { authorization: `Bearer ${accessToken}` }, allowedHosts, maxBytes: 256 * 1024 });
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
      const parsed = vaultIdentityLookupSchema.safeParse(doc);
      return parsed.success ? { status: 'ok', items: parsed.data.data } : { status: 'unavailable', code: 'bad_response' };
    }
    if (res.status === 401) return { status: 'unauthorized' };
    if (res.status === 403) {
      let code: unknown;
      try {
        code = (JSON.parse(res.body) as { code?: unknown } | null)?.code;
      } catch {
        // not JSON
      }
      return code === VAULT_IDENTITY_DISABLED || code === VAULT_ERROR_CODES.disabled ? { status: 'identity_disabled' } : { status: 'unauthorized' };
    }
    return { status: 'unavailable', code: `http_${res.status}` };
  }

  /**
   * `GET /cards?origin=` (contract 1.1, scope `vault:cards_read`): the owner's opened cards that hold a live merchant grant for
   * `merchantOrigin` (matched by registrable domain on Vault's side), to LIST on the Secrets page. Vault's agent API lists a card
   * only for a merchant it is granted for, so there is no call that lists every card. Never a number or a code; nothing is logged.
   */
  async cards(baseUrl: string, accessToken: string, merchantOrigin: string, allowedHosts: readonly string[] = []): Promise<CardListResult> {
    const base = baseUrl.replace(/\/+$/, '');
    let res;
    try {
      res = await this.http.send({ method: 'GET', url: `${base}${VAULT_AGENT_API_PATH}/cards?origin=${encodeURIComponent(merchantOrigin)}`, headers: { authorization: `Bearer ${accessToken}` }, allowedHosts, maxBytes: 256 * 1024 });
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
      const parsed = vaultCardsLookupSchema.safeParse(doc);
      return parsed.success ? { status: 'ok', cards: parsed.data.data } : { status: 'unavailable', code: 'bad_response' };
    }
    if (res.status === 401) return { status: 'unauthorized' };
    if (res.status === 403) {
      let code: unknown;
      try {
        code = (JSON.parse(res.body) as { code?: unknown } | null)?.code;
      } catch {
        // not JSON
      }
      return code === VAULT_CARD_DISABLED || code === VAULT_ERROR_CODES.disabled ? { status: 'cards_disabled' } : { status: 'unauthorized' };
    }
    return { status: 'unavailable', code: `http_${res.status}` };
  }

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
