// The built-in store as a `SecretsProvider` (E37.5, #594): `SecretsProviderPort` (secrets-provider.port.ts) over the
// in-process agent service of `@marinoscar/vault-api` (`AgentReleasePort`). The rules are Vault's, enforced by Vault's
// own code, not re-implemented here:
//
//   - per-item opt-in: only a login the owner opened to agents (`agentAccess = fill`, set by the owner's session) is
//     visible; any other id, and another user's id, is ONE identical 404;
//   - exact origin binding: a release names the page's origin and Vault compares it with the login's origins (403
//     ORIGIN_MISMATCH otherwise); `matchKind: 'site'` is never fillable;
//   - one field per call (`username` or `password`), a TOTP code as its own call;
//   - an audit row per call (`agent.credential.*`, `credential: 'embedded'`, label `hexactra-agent`), rate limits per
//     minute, and the kill switch (`agentAccess.enabled`, bound to the deployment's `secrets.agentUse`).
//
// On top of Vault's rules the console adds its own two switches (the deployment's and the owner's, both off by
// default) and requires that the owner has CHOSEN the built-in store (one provider is active at a time).
//
// A value crosses this process: Vault's service returns a JS string, which this class turns into a Buffer at once
// (`SecretBytes.take`); the caller writes it to the response and wipes it. A JS string cannot be wiped, so the string
// that Vault's service decrypted lives until the garbage collector frees it: the remote Vault path does not have this
// exposure (docs/secrets.md, "What the built-in store cannot do").
import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { AGENT_RELEASE_PORT, type AgentReleasePort } from '@marinoscar/vault-api/agent';

import { SecretsPolicyService } from '../secrets-policy.service';
import {
  SecretBytes,
  SecretsProviderError,
  type CodeRequest,
  type ItemKind,
  type ItemSummary,
  type ReleaseRequest,
  type SecretField,
  type SecretPurpose,
  type SecretsErrorCode,
  type SecretsProviderPort,
} from '../secrets-provider.port';
import { SecretsStoreKeys } from './store.data-keys';

/** What the owner sees as the app in Vault's agent trail. Stable: a new label is a new app. */
export const STORE_CLIENT_LABEL = 'hexactra-agent';

type AgentPurpose = 'login' | 'signup' | 'password_change' | 'mfa';
const PURPOSES: Partial<Record<SecretPurpose, AgentPurpose>> = { login: 'login', signup: 'signup', password_change: 'password_change', mfa: 'mfa' };
const FIELDS: Partial<Record<SecretField, 'username' | 'password'>> = { username: 'username', password: 'password' };

/** Vault's HTTP errors, as the provider contract's closed codes. Never carries the message. */
export function mapStoreError(e: unknown): SecretsProviderError {
  if (e instanceof SecretsProviderError) return e;
  if (e instanceof HttpException) {
    const status = e.getStatus();
    const body = e.getResponse() as { code?: unknown } | string;
    const code = typeof body === 'object' && body !== null && typeof body.code === 'string' ? body.code : undefined;
    if (status === 404) return new SecretsProviderError('not_found', 'No such login is open to the agent.');
    if (status === 429) {
      const retry = Number((e as { retryAfter?: unknown }).retryAfter);
      return new SecretsProviderError('rate_limited', 'Too many requests.', Number.isFinite(retry) ? retry : undefined);
    }
    if (status === 403) {
      const map: Record<string, SecretsErrorCode> = { ORIGIN_MISMATCH: 'origin_mismatch', AGENT_ACCESS_DISABLED: 'disabled' };
      return new SecretsProviderError((code && map[code]) || 'refused', 'The built-in store refused the request.');
    }
    if (status === 400) return new SecretsProviderError('refused', 'The request was not accepted.');
  }
  return new SecretsProviderError('unavailable', 'The built-in store could not answer.');
}

@Injectable()
export class BuiltinSecretsProvider implements SecretsProviderPort {
  readonly id = 'builtin';
  private readonly log = new Logger(BuiltinSecretsProvider.name);

  constructor(
    @Inject(AGENT_RELEASE_PORT) private readonly agent: AgentReleasePort,
    private readonly keys: SecretsStoreKeys,
    private readonly policy: SecretsPolicyService,
  ) {}

  /** The console's own gate: both switches on and the built-in store chosen. A failure is `disabled`, with no detail. */
  private async gate(ownerId: string): Promise<void> {
    const use = await this.policy.agentUse(ownerId);
    if (!use.effective || (await this.policy.activeProvider(ownerId)) !== 'builtin') throw new SecretsProviderError('disabled', 'The built-in store is not enabled for this owner.');
  }

  /** Runs `fn` with the owner's data key loaded for decrypting; maps every failure to the contract's codes. */
  private async run<R>(ownerId: string, fn: () => Promise<R>): Promise<R> {
    await this.gate(ownerId);
    try {
      // `create: false`: an owner with no key has no secrets; a lookup must not create one.
      return await this.keys.scope(ownerId, { create: false }, fn);
    } catch (e) {
      const mapped = mapStoreError(e);
      if (mapped.code === 'unavailable') this.log.warn(`the built-in store failed (${e instanceof Error ? e.name : 'error'})`);
      throw mapped;
    }
  }

  async lookup(ownerId: string, origin: string, kind: ItemKind): Promise<ItemSummary[]> {
    if (kind !== 'login') return [];
    const rows = await this.run(ownerId, () => this.agent.lookup({ userId: ownerId, clientLabel: STORE_CLIENT_LABEL, origin }));
    return rows.map((r) => ({ id: r.id, name: r.name, ...(r.username ? { username: r.username } : {}), origins: r.origins, matchKind: r.matchKind, hasCode: r.hasTotp, updatedAt: new Date(r.updatedAt) }));
  }

  async release(req: ReleaseRequest): Promise<SecretBytes> {
    const field = FIELDS[req.field];
    const purpose = PURPOSES[req.purpose];
    if (!field || !purpose) throw new SecretsProviderError('unsupported', 'The built-in store releases a login’s username and password only.');
    const { value } = await this.run(req.ownerId, () => this.agent.fill({ userId: req.ownerId, clientLabel: req.clientLabel || STORE_CLIENT_LABEL, secretId: req.itemId, field, origin: req.origin, purpose }));
    // The string is Vault's; take it into a Buffer now and let the caller wipe that.
    return SecretBytes.take(Buffer.from(value, 'utf8'));
  }

  async oneTimeCode(req: CodeRequest): Promise<{ value: SecretBytes; expiresAt: Date }> {
    const purpose = PURPOSES[req.purpose];
    if (!purpose) throw new SecretsProviderError('unsupported', 'The built-in store releases a login’s codes only.');
    const r = await this.run(req.ownerId, () => this.agent.totp({ userId: req.ownerId, clientLabel: req.clientLabel || STORE_CLIENT_LABEL, secretId: req.itemId, origin: req.origin, purpose }));
    return { value: SecretBytes.take(Buffer.from(r.code, 'utf8')), expiresAt: new Date(r.expiresAt) };
  }
}
