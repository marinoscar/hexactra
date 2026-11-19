// What the owner granted for a merchant, for the Secrets page (E37.7, #596): the cards the provider lists for ONE merchant, each
// with its brand, last four digits, expiry and the grant (limit, currency, whether the security code is included), read-only.
//
// Vault's agent API lists a card only for a merchant it holds a live grant for, so there is no call that lists every card: the page
// asks per merchant ("check a merchant"). The console reads the provider's card lookup with the owner's own access token, only to
// show the list. Nothing here is stored, logged or sent to a model; a number or a code never reaches this process.
import { Injectable, Logger } from '@nestjs/common';

import { registrableDomain } from '../approvals/approval-match';
import { SecretsPolicyService } from './secrets-policy.service';
import { VaultApiClient } from './vault-api.client';
import { VaultConnectionService } from './vault-connection.service';
import { hasCardScopes } from './vault-contract';
import { VaultAccessError, VaultTokenService } from './vault-token.service';

export type CardListReason = 'ok' | 'not_connected' | 'needs_reconnect' | 'needs_scope' | 'switched_off' | 'provider_off' | 'unavailable' | 'bad_merchant';

export interface CardListing {
  /** The owner's cards can be read and used: connected, the switches on and the card permissions granted. */
  available: boolean;
  reason: CardListReason;
  /** The merchant asked about, as `https://<host>`; null when it was not a usable address. */
  merchant: string | null;
  /** The cards granted for that merchant. Never a number, an expiry month beyond MM/YYYY, or a code. */
  cards: { name: string; brand: string | null; last4: string | null; expires: string | null; limit: { maxAmount: string; currency: string; includesSecurityCode: boolean; expiresAt: string | null } }[];
  /** The provider's address, where each card's merchant grants are made; null when there is none. */
  manageUrl: string | null;
}

const MAX_TEXT = 120;
const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

/** A merchant the owner typed (`shop.example.test` or `https://shop.example.test/x`) as an `https` origin on a real site; null otherwise. */
export function merchantOriginOf(input: string): string | null {
  const t = input.trim();
  if (!t || t.length > 300) return null;
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return registrableDomain(u.href) ? u.origin : null;
  } catch {
    return null;
  }
}

@Injectable()
export class SecretsCardsService {
  private readonly log = new Logger(SecretsCardsService.name);

  constructor(
    private readonly policy: SecretsPolicyService,
    private readonly connection: VaultConnectionService,
    private readonly tokens: VaultTokenService,
    private readonly api: VaultApiClient,
  ) {}

  async list(userId: string, merchant: string): Promise<CardListing> {
    const empty = (reason: CardListReason, origin: string | null, manageUrl: string | null = null): CardListing => ({ available: false, reason, merchant: origin, cards: [], manageUrl });
    const status = (await this.connection.status(userId)).providers.vault;
    const manageUrl = status.baseUrl ?? null;
    const origin = merchantOriginOf(merchant);
    if (!origin) return empty('bad_merchant', null, manageUrl);
    if (!(await this.policy.agentUse(userId)).effective) return empty('switched_off', origin, manageUrl);
    if (status.status === 'needs_reconnect') return empty('needs_reconnect', origin, manageUrl);
    if (status.status !== 'connected') return empty('not_connected', origin, manageUrl);
    if (!hasCardScopes(status.scopes)) return empty('needs_scope', origin, manageUrl);
    let access;
    try {
      access = await this.tokens.getAccess(userId);
    } catch (e) {
      if (e instanceof VaultAccessError) return empty(e.kind === 'needs_reconnect' ? 'needs_reconnect' : e.kind === 'not_connected' ? 'not_connected' : 'unavailable', origin, manageUrl);
      throw e;
    }
    const allowedHosts = (await this.policy.system()).vault.allowedHosts;
    const r = await this.api.cards(access.baseUrl, access.accessToken, origin, allowedHosts);
    if (r.status === 'cards_disabled') return empty('provider_off', origin, manageUrl);
    if (r.status === 'unauthorized') return empty('needs_scope', origin, manageUrl);
    if (r.status === 'unavailable') {
      this.log.warn(`could not list cards (${r.code})`);
      return empty('unavailable', origin, manageUrl);
    }
    return {
      available: true,
      reason: 'ok',
      merchant: origin,
      manageUrl,
      cards: r.cards.map((c) => ({
        name: clip(c.name),
        brand: c.brand ? clip(c.brand).slice(0, 30) : null,
        last4: c.last4 && /^\d{1,4}$/.test(c.last4) ? c.last4 : null,
        expires: c.expMonth && c.expYear && /^\d{1,2}$/.test(c.expMonth) && /^\d{2,4}$/.test(c.expYear) ? `${c.expMonth.padStart(2, '0')}/${c.expYear}` : null,
        limit: { maxAmount: c.grant.maxAmount.toFixed(2), currency: c.grant.currency.toUpperCase().slice(0, 3), includesSecurityCode: c.grant.includesSecurityCode, expiresAt: c.grant.expiresAt ?? null },
      })),
    };
  }
}
