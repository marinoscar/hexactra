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
//
// Keys of outside services (E50.3, #973): a `Service Key` item of the Vault domain (kind `api_key`: a service, a key name, one value,
// no origin). The console's own server reads one through Vault's in-process `ServiceKeyReleasePort` (its rules: the kill switch,
// the per-item opt-in, 120 a minute per owner and service, an audit row `agent.service_key.read` with the label
// `hexactra-console`), and writes one only when the owner moves their key here (Settings → Secrets). `lookup` lists logins only, so a
// service key is never offered to the agent as a login, and the fabric's routes cannot name one.
import { HttpException, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AGENT_RELEASE_PORT, AgentCredentialsService, SERVICE_KEY_RELEASE_PORT, type AgentReleasePort, type ServiceKeyReleasePort } from '@marinoscar/vault-api/agent';
import { SecretsService } from '@marinoscar/vault-api/secrets';
import { SERVICE_KEY_NAME_FIELD, SERVICE_KEY_SERVICE_FIELD, SERVICE_KEY_TYPE_NAME, SERVICE_KEY_VALUE_FIELD } from '@marinoscar/vault-contract/secret-types';

import { PrismaService } from '../../prisma/prisma.service';
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
  type ServiceKeyRequest,
} from '../secrets-provider.port';
import { SecretsServiceKeys, type BuiltinServiceKeyStore } from '../service-keys';
import { SecretsStoreKeys } from './store.data-keys';

/** What the owner sees as the app in Vault's agent trail. Stable: a new label is a new app. */
export const STORE_CLIENT_LABEL = 'hexactra-agent';
/** The label of the console's own server-side reads of a service key: a distinct app in Vault's trail, so the owner tells them apart. */
export const STORE_SERVICE_CLIENT_LABEL = 'hexactra-console';

/** The name a service key the console wrote has in the store: how it finds it again to replace, describe or remove it. */
export const serviceKeyItemName = (service: string, name: string): string => `Service key ${service}.${name}`;

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
    if (status === 409) {
      if (code === 'SERVICE_KEY_AMBIGUOUS') return new SecretsProviderError('refused', 'More than one key with this service and name is open to the agent.');
      return new SecretsProviderError('name_taken', 'A secret with that name already exists.');
    }
  }
  return new SecretsProviderError('unavailable', 'The built-in store could not answer.');
}

@Injectable()
export class BuiltinSecretsProvider implements SecretsProviderPort, BuiltinServiceKeyStore, OnModuleInit {
  readonly id = 'builtin';
  private readonly log = new Logger(BuiltinSecretsProvider.name);

  constructor(
    @Inject(AGENT_RELEASE_PORT) private readonly agent: AgentReleasePort,
    private readonly keys: SecretsStoreKeys,
    private readonly policy: SecretsPolicyService,
    private readonly credentials: AgentCredentialsService,
    @Inject(SERVICE_KEY_RELEASE_PORT) private readonly serviceKeys: ServiceKeyReleasePort,
    private readonly secrets: SecretsService,
    private readonly prisma: PrismaService,
    private readonly serviceKeyHost: SecretsServiceKeys,
  ) {}

  /** Offers the store's service keys to the service credentials port (E50.3). */
  onModuleInit(): void {
    this.serviceKeyHost.attachBuiltin(this);
  }

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

  /**
   * "Save this login?" (#712): the owner's sign-in, typed by hand for the agent, created in the store as a Credential bound to the
   * page's exact origin and open to the agent (the owner pressed Save on a card that says so). Vault's own create runs it: its
   * kill switch, rate limit and audit row. The password arrives from the fabric and is handed to Vault's service at once; the
   * caller wipes its buffer. A taken name is `name_taken`.
   */
  async saveLogin(req: { ownerId: string; name: string; username: string; origin: string; password: Buffer; clientLabel?: string }): Promise<{ id: string }> {
    await this.gate(req.ownerId);
    try {
      // `create: true`: the owner's first saved login creates their data key.
      return await this.keys.scope(req.ownerId, { create: true }, async () => {
        const r = await this.credentials.create({ userId: req.ownerId, clientLabel: req.clientLabel || STORE_CLIENT_LABEL }, { name: req.name, username: req.username, origin: req.origin, password: req.password.toString('utf8'), purpose: 'login' });
        return { id: r.id };
      });
    } catch (e) {
      const mapped = mapStoreError(e);
      if (mapped.code === 'unavailable') this.log.warn(`the built-in store could not save a login (${e instanceof Error ? e.name : 'error'})`);
      throw mapped;
    }
  }

  async oneTimeCode(req: CodeRequest): Promise<{ value: SecretBytes; expiresAt: Date }> {
    const purpose = PURPOSES[req.purpose];
    if (!purpose) throw new SecretsProviderError('unsupported', 'The built-in store releases a login’s codes only.');
    const r = await this.run(req.ownerId, () => this.agent.totp({ userId: req.ownerId, clientLabel: req.clientLabel || STORE_CLIENT_LABEL, secretId: req.itemId, origin: req.origin, purpose }));
    return { value: SecretBytes.take(Buffer.from(r.code, 'utf8')), expiresAt: new Date(r.expiresAt) };
  }

  // ---- keys of outside services (E50.3) ----

  /**
   * The gate of a server-side release: the deployment's `secrets.agentUse` (the kill switch of every release), the store offered
   * (`secrets.store.enabled`) and chosen by the owner. The owner's own agent-use switch is about pages and is not asked: the owner
   * chose this store for the key by moving it here.
   */
  private async serviceKeyGate(ownerId: string, release: boolean): Promise<void> {
    if (release && !(await this.policy.system()).agentUse.enabled) throw new SecretsProviderError('disabled', 'Releases from the built-in store are switched off.');
    if ((await this.policy.activeProvider(ownerId)) !== 'builtin') throw new SecretsProviderError('disabled', 'The built-in store is not enabled for this owner.');
  }

  private async serviceKeyRun<R>(ownerId: string, create: boolean, fn: () => Promise<R>): Promise<R> {
    try {
      return await this.keys.scope(ownerId, { create }, fn);
    } catch (e) {
      const mapped = mapStoreError(e);
      if (mapped.code === 'unavailable') this.log.warn(`the built-in store failed on a service key (${e instanceof Error ? e.name : 'error'})`);
      throw mapped;
    }
  }

  async releaseServiceKey(req: ServiceKeyRequest): Promise<SecretBytes> {
    await this.serviceKeyGate(req.ownerId, true);
    const { value } = await this.serviceKeyRun(req.ownerId, false, () => this.serviceKeys.releaseServiceKey({ userId: req.ownerId, clientLabel: STORE_SERVICE_CLIENT_LABEL, service: req.service, name: req.name }));
    // Vault hands over a Buffer the caller owns: take it as is, the caller wipes it.
    return SecretBytes.take(value);
  }

  /** The store's item of a key the console wrote (by its name), or null. Never decrypted. */
  private findServiceKeyItem(ownerId: string, service: string, name: string): Promise<{ id: string; updatedAt: Date } | null> {
    return this.prisma.secret.findFirst({ where: { createdById: ownerId, name: serviceKeyItemName(service, name), type: { name: SERVICE_KEY_TYPE_NAME, isSystem: true } }, select: { id: true, updatedAt: true } });
  }

  /** When the owner's key `service`/`name` was last written here, or null when there is none. Never a value. */
  async describeServiceKey(ownerId: string, service: string, name: string): Promise<Date | null> {
    if (!(await this.policy.storeEnabled())) return null;
    return (await this.findServiceKeyItem(ownerId, service, name))?.updatedAt ?? null;
  }

  /**
   * Writes the owner's key `service`/`name` as a `Service Key` item opened to the agent (`agentAccess = fill`), replacing the one the
   * console wrote before. Vault's own service encrypts and audits it (`secret.create` or `secret.update`). The value crosses this
   * process as a string for Vault's service (its DTO is JSON): the caller's buffer is wiped by the caller.
   */
  async saveServiceKey(ownerId: string, service: string, name: string, label: string, value: Buffer): Promise<void> {
    await this.serviceKeyGate(ownerId, false);
    await this.serviceKeyRun(ownerId, true, async () => {
      const data = { [SERVICE_KEY_SERVICE_FIELD]: service, [SERVICE_KEY_NAME_FIELD]: name, [SERVICE_KEY_VALUE_FIELD]: value.toString('utf8'), notes: `${label}. Written by Hexactra; read by its server for calls to this service.` };
      const existing = await this.findServiceKeyItem(ownerId, service, name);
      let id: string;
      if (existing) {
        await this.secrets.update(existing.id, { data } as never, ownerId, []);
        id = existing.id;
      } else {
        const type = await this.prisma.secretType.findFirst({ where: { name: SERVICE_KEY_TYPE_NAME, isSystem: true }, select: { id: true } });
        if (!type) throw new SecretsProviderError('unavailable', 'The built-in store has no service key type yet.');
        const created = (await this.secrets.create({ name: serviceKeyItemName(service, name), typeId: type.id, data } as never, ownerId, [])) as { id: string };
        id = created.id;
      }
      await this.secrets.updateAgentAccess(id, 'fill', ownerId, []);
    });
  }

  /** Removes the owner's key `service`/`name` the console wrote. Idempotent. */
  async removeServiceKey(ownerId: string, service: string, name: string): Promise<void> {
    if (!(await this.policy.storeEnabled())) throw new SecretsProviderError('disabled', 'The built-in store is switched off.');
    await this.serviceKeyRun(ownerId, false, async () => {
      const existing = await this.findServiceKeyItem(ownerId, service, name);
      if (existing) await this.secrets.remove(existing.id, ownerId, []);
    });
  }
}
