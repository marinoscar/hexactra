import { FabricClient, FabricError } from '../fabric/fabric.client';
import {
  SECRETS_ERROR_CODES,
  SecretsProviderError,
  type ItemKind,
  type ItemSummary,
  type SecretField,
  type SecretPurpose,
  type SecretsErrorCode,
  type SecretsProviderRegistration,
  type SecretsProviderView,
} from '../secrets/secrets-provider.port';
import { traceFabric } from './agent-trace-fabric';
import { handoffBody, type CreatedHandoff, type FabricHandoff, type FabricOperation, type HandoffRequest } from './fabric-handoff';
import { dateOf, itemOf, providerMeta, providerViewOf, secretsErrorOf, secretsResult, target, type WireItem, type WireProviderView, type ProviderCallOptions, type SecretsLookupResult, type SelectFromProviderOptions, type TypeCardFieldOptions, type TypeCodeFromProviderOptions, type TypeFromProviderOptions } from './fabric-secrets-calls';

export * from './fabric-handoff';
export * from './fabric-secrets-calls';

/** How long a run waits for a person who took over its browser (#342). */
export const TAKEOVER_WAIT_MS = 30 * 60_000;
const TAKEOVER_POLL_MS = 5_000;

/** The fabric refused because a person controls the host's desktop. */
export const isTakeoverActive = (e: unknown): e is FabricError => e instanceof FabricError && e.status === 409 && e.code === 'takeover_active';

/** The fabric calls a run makes, over the console's FabricClient. */
/** How long the host has to run one action before the console gives up on it. */
export const ACTION_TIMEOUT_MS = 45_000;

export class FabricSession {
  constructor(
    private readonly fabric: FabricClient,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /**
   * Opens a fabric session. `allowedDomains` (#465): the sites the session
   * may visit, sent as `allowed_domains` so a fabric that enforces them does
   * so on its side too; the console checks every navigation itself either way.
   * `ownerId` (#590): whose session this is. The fabric's secrets provider
   * actions use the providers registered for that owner.
   */
  async create(opts: { profile: string; hostId: string | null; label: string; allowedDomains?: readonly string[]; ownerId?: string }): Promise<string> {
    const s = await this.fabric.request<{ id: string }>('POST', '/v1/sessions', {
      body: {
        profile: opts.profile,
        label: opts.label,
        ...(opts.hostId ? { host_id: opts.hostId } : {}),
        ...(opts.allowedDomains?.length ? { allowed_domains: [...opts.allowedDomains] } : {}),
        ...(opts.ownerId ? { owner_id: opts.ownerId } : {}),
      },
    });
    return s.id;
  }

  /**
   * Runs one action. While a person controls the host's desktop (#342) the
   * fabric refuses new actions with `409 takeover_active`: by default this
   * waits (up to 30 minutes) and runs the step once they release it;
   * `waitForTakeover: false` throws at once instead (an external agent
   * decides itself when to retry). `signal` (Stop, E38.1) ends the wait at once: the request is dropped
   * (a `FabricError` of kind `aborted`); the fabric has no operation cancel, so the host finishes the action
   * on its own, within `timeoutMs`.
   */
  async act(sessionId: string, action: Record<string, unknown>, timeoutMs = ACTION_TIMEOUT_MS, opts: { waitForTakeover?: boolean; signal?: AbortSignal } = {}): Promise<FabricOperation> {
    // Inside a run's trace this is a `hexactra.fabric <action>` span (E38.4); anywhere else, no span. Only the action's type is named.
    return traceFabric(String(action.type ?? 'action'), async () => {
      const until = Date.now() + TAKEOVER_WAIT_MS;
      for (;;) {
        try {
          return await this.fabric.request<FabricOperation>('POST', `/v1/sessions/${sessionId}/actions`, {
            body: { action, timeout_ms: timeoutMs },
            timeoutMs: timeoutMs + 15_000,
            ...(opts.signal ? { signal: opts.signal } : {}),
          });
        } catch (e) {
          if (opts.waitForTakeover === false || !isTakeoverActive(e) || Date.now() >= until || opts.signal?.aborted) throw e;
          await this.sleep(TAKEOVER_POLL_MS);
        }
      }
    });
  }

  /**
   * Whether the fabric still has this session open (a resumed run checks, E38.2). Only a definite answer says no: a session the
   * fabric does not know (404) or reports `ended`. A fabric that cannot be reached counts as alive, so the run's next action
   * fails the usual way instead of the run opening a second browser.
   */
  async isAlive(sessionId: string): Promise<boolean> {
    try {
      const s = await this.fabric.request<{ status?: string }>('GET', `/v1/sessions/${sessionId}`);
      return s.status !== 'ended';
    } catch (e) {
      return !(e instanceof FabricError && e.status === 404);
    }
  }

  async end(sessionId: string): Promise<void> {
    await this.fabric.request('DELETE', `/v1/sessions/${sessionId}`).catch(() => undefined);
  }

  async createHandoff(sessionId: string, req: HandoffRequest): Promise<string> {
    return (await this.openHandoff(sessionId, req)).id;
  }

  /** Create a handoff and keep what the inbox shows (viewer link, page title, expiry). */
  async openHandoff(sessionId: string, req: HandoffRequest): Promise<CreatedHandoff> {
    const r = await this.fabric.request<{ handoff: Partial<FabricHandoff> & { id: string } }>('POST', `/v1/sessions/${sessionId}/handoffs`, { body: handoffBody(req) });
    const h = r.handoff;
    const expires = h.expires_at ? new Date(h.expires_at) : null;
    return { id: h.id, viewerUrl: h.viewer_url ?? null, pageTitle: h.page?.title ?? null, pageUrl: h.page?.url ?? null, expiresAt: expires && !Number.isNaN(expires.getTime()) ? expires : null };
  }

  /** Answer a handoff with the console's service token, as `answeredBy` (e.g. `user:<id>`). */
  async respond(id: string, answer: { outcome: 'completed' | 'cancelled'; value?: string; values?: string[]; secret?: string; remember?: boolean; channel?: string; answeredBy?: string }): Promise<void> {
    await this.fabric.request('POST', `/v1/handoffs/${id}/respond`, {
      body: {
        outcome: answer.outcome,
        ...(answer.value !== undefined ? { value: answer.value } : {}),
        ...(answer.values !== undefined ? { values: answer.values } : {}),
        // A sign-in's password travels in this call only (#527).
        ...(answer.secret !== undefined ? { secret: answer.secret } : {}),
        ...(answer.remember !== undefined ? { remember: answer.remember } : {}),
        ...(answer.channel ? { channel: answer.channel } : {}),
        ...(answer.answeredBy ? { answered_by: answer.answeredBy } : {}),
      },
    });
  }

  /** Withdraw a pending handoff (best effort). */
  async cancelHandoff(id: string): Promise<void> {
    await this.fabric.request('POST', `/v1/handoffs/${id}/cancel`).catch(() => undefined);
  }

  getHandoff(id: string): Promise<FabricHandoff> {
    return this.fabric.request<FabricHandoff>('GET', `/v1/handoffs/${id}`);
  }

  /**
   * Type the answer of a `secret` handoff into `selector` with the fabric's
   * `type_secret` action: the fabric types it on the host, so the plaintext
   * never reaches the console. Single use; the fabric refuses (409
   * `secret_unavailable`) when it was already used, erased or expired.
   */
  typeSecret(sessionId: string, opts: { handoffId: string; selector: string; clear?: boolean; submit?: boolean; tabId?: number }, timeoutMs?: number): Promise<FabricOperation> {
    return this.act(
      sessionId,
      {
        type: 'type_secret',
        handoff_id: opts.handoffId,
        selector: opts.selector,
        clear: opts.clear ?? true,
        submit: opts.submit ?? false,
        ...(opts.tabId !== undefined ? { tab_id: opts.tabId } : {}),
      },
      timeoutMs,
    );
  }

  // ------------------------------------------------- secrets providers (#590)

  /**
   * Ask the owner's secrets provider which items it offers for the page the
   * session is on. The fabric reads the tab's top-level origin itself; the
   * model never names one. Never a value. Throws {@link SecretsProviderError}.
   */
  async secretsLookup(sessionId: string, kind: ItemKind = 'login', opts: ProviderCallOptions = {}): Promise<SecretsLookupResult> {
    const op = await this.act(sessionId, { type: 'secrets_lookup', kind, ...providerMeta(opts) }, opts.timeoutMs, { waitForTakeover: opts.waitForTakeover });
    const r = secretsResult(op) as { origin: string; provider: string; items?: WireItem[] };
    return { origin: r.origin, provider: r.provider, items: (r.items ?? []).map(itemOf) };
  }

  /**
   * Fetch one field of one item and type it into the target (a `selector` in
   * the top-level document, or a `point` outside any foreign frame). The
   * fabric re-reads the tab's origin at that moment, asks the provider with it,
   * types with trusted input and wipes the value: the answer is only
   * `{ typed: true }`, never the value, never its length.
   */
  /**
   * Sign in with a Hexactra passkey (E47.4): the browser host presses `selector`, answers the page's WebAuthn request with the owner's
   * passkey for that site, and reports only `{ signed_in, rp_id }`. Never a key, a signature or the page's challenge.
   */
  async passkeySignIn(sessionId: string, opts: { selector: string } & ProviderCallOptions): Promise<{ rpId: string }> {
    const op = await this.act(sessionId, { type: 'passkey_sign_in', selector: opts.selector, ...providerMeta(opts) }, opts.timeoutMs, { waitForTakeover: opts.waitForTakeover });
    const r = secretsResult(op) as { rp_id?: string };
    return { rpId: String(r.rp_id ?? '') };
  }

  /** Add a Hexactra passkey to the site (E47.4): presses `selector`, makes and keeps a key pair, answers the page. */
  async passkeyCreate(sessionId: string, opts: { selector: string } & ProviderCallOptions): Promise<{ rpId: string; userName: string }> {
    const op = await this.act(sessionId, { type: 'passkey_create', selector: opts.selector, ...providerMeta(opts) }, opts.timeoutMs, { waitForTakeover: opts.waitForTakeover });
    const r = secretsResult(op) as { rp_id?: string; user_name?: string };
    return { rpId: String(r.rp_id ?? ''), userName: String(r.user_name ?? '') };
  }

  async typeFromProvider(sessionId: string, opts: TypeFromProviderOptions): Promise<{ typed: true }> {
    const op = await this.act(
      sessionId,
      {
        type: 'type_from_provider',
        item_id: opts.itemId,
        field: opts.field,
        ...target(opts),
        purpose: opts.purpose ?? 'login',
        clear: opts.clear ?? true,
        submit: opts.submit ?? false,
        ...providerMeta(opts),
      },
      opts.timeoutMs,
      { waitForTakeover: opts.waitForTakeover },
    );
    secretsResult(op);
    return { typed: true };
  }

  /**
   * Choose the option of a `<select>` that matches one field of one item (E37.6): a country, or the day, month or year of
   * a date of birth split in three selects (`part`). The fabric lists the options, picks one itself and wipes the value:
   * the answer is only `{ selected: true }`, never the value, never which option.
   */
  async selectFromProvider(sessionId: string, opts: SelectFromProviderOptions): Promise<{ selected: true }> {
    const op = await this.act(
      sessionId,
      { type: 'select_from_provider', item_id: opts.itemId, field: opts.field, selector: opts.selector, ...(opts.part ? { part: opts.part } : {}), ...providerMeta(opts) },
      opts.timeoutMs,
      { waitForTakeover: opts.waitForTakeover },
    );
    secretsResult(op);
    return { selected: true };
  }

  /**
   * Type one field of a saved card into the target (E37.7), under the owner's merchant grant: a `selector` in the
   * top-level document, or a `point` (which may lie inside an embedded payment frame; the fabric reads the frame's
   * origin itself and refuses when it cannot). The fabric reads the merchant's top-level origin, asks the provider
   * with it, the frame's origin, the amount and the currency, types with trusted input and wipes the value: the answer
   * is `{ typed: true, frameOrigin? }`, never the value. `expiry` is composed `MM/YY` inside the fabric.
   */
  async typeCardField(sessionId: string, opts: TypeCardFieldOptions): Promise<{ typed: true; frameOrigin: string | null }> {
    const op = await this.act(
      sessionId,
      { type: 'type_card_field', item_id: opts.itemId, field: opts.field, ...target(opts), amount: opts.amount, currency: opts.currency, clear: opts.clear ?? true, ...providerMeta(opts) },
      opts.timeoutMs,
      { waitForTakeover: opts.waitForTakeover },
    );
    const r = secretsResult(op) as { frame_origin?: string | null };
    return { typed: true, frameOrigin: r.frame_origin ?? null };
  }

  /** Like {@link typeFromProvider} with a one-time code fetched immediately before typing. */
  async typeCodeFromProvider(sessionId: string, opts: TypeCodeFromProviderOptions): Promise<{ typed: true; expiresAt: Date | null }> {
    const op = await this.act(
      sessionId,
      { type: 'type_code_from_provider', item_id: opts.itemId, ...target(opts), clear: opts.clear ?? false, submit: opts.submit ?? false, ...providerMeta(opts) },
      opts.timeoutMs,
      { waitForTakeover: opts.waitForTakeover },
    );
    const r = secretsResult(op) as { expires_at?: string };
    return { typed: true, expiresAt: dateOf(r.expires_at) };
  }

  /**
   * Tell the fabric which provider an owner's sessions use and how to call it
   * (`PUT /v1/secrets-providers/{owner}/{provider}`). The token is held in the
   * fabric's memory only and refreshed by calling this again; it is never
   * returned. A `FabricError` with code `provider_kind_unsupported` (501) means
   * this fabric does not implement the kind yet.
   */
  async registerSecretsProvider(ownerId: string, config: SecretsProviderRegistration): Promise<SecretsProviderView> {
    const v = await this.fabric.request<WireProviderView>('PUT', `/v1/secrets-providers/${encodeURIComponent(ownerId)}/${encodeURIComponent(config.provider)}`, {
      body: {
        kind: config.kind,
        ...(config.baseUrl ? { base_url: config.baseUrl } : {}),
        ...(config.accessToken ? { access_token: config.accessToken } : {}),
        ...(config.expiresAt ? { expires_at: config.expiresAt.toISOString() } : {}),
        ...(config.settings ? { settings: config.settings } : {}),
      },
    });
    return providerViewOf(v);
  }

  /** Drop an owner's provider registration, and with it the fabric's copy of its token. Idempotent. */
  async unregisterSecretsProvider(ownerId: string, provider: string): Promise<void> {
    await this.fabric.request('DELETE', `/v1/secrets-providers/${encodeURIComponent(ownerId)}/${encodeURIComponent(provider)}`);
  }

  /**
   * Save the sign-in the owner typed into a `credentials` handoff created with `offerSave` (E37.4b): the fabric sends the
   * password it still holds to the provider's create route (purpose `save_login`), bound to `origin`. The answer is the
   * provider's id of the new login, never the password. Throws {@link SecretsProviderError}: `secret_unavailable` means the
   * fabric no longer holds the password (too late), `name_taken` that the owner has a secret with that name.
   */
  async saveLogin(ownerId: string, provider: string, req: { handoffId: string; name: string; origin: string; runId?: string; clientLabel?: string }): Promise<{ itemId: string | null }> {
    try {
      const r = await this.fabric.request<{ saved?: boolean; item_id?: string | null }>('POST', `/v1/secrets-providers/${encodeURIComponent(ownerId)}/${encodeURIComponent(provider)}/save-login`, {
        body: { handoff_id: req.handoffId, name: req.name, origin: req.origin, ...(req.runId ? { run_id: req.runId } : {}), ...(req.clientLabel ? { client_label: req.clientLabel } : {}) },
        timeoutMs: 30_000,
        retries: 0,
      });
      if (r.saved !== true) throw new SecretsProviderError('unknown', 'The provider did not confirm the save');
      return { itemId: r.item_id ?? null };
    } catch (e) {
      if (e instanceof FabricError && e.kind === 'api') {
        const known = (SECRETS_ERROR_CODES as readonly string[]).includes(e.code ?? '');
        throw new SecretsProviderError(known ? (e.code as SecretsErrorCode) : 'unknown', e.message);
      }
      throw e;
    }
  }

  /** The owner's live registrations (never a token). */
  async listSecretsProviders(ownerId: string): Promise<SecretsProviderView[]> {
    const r = await this.fabric.request<{ providers: WireProviderView[] }>('GET', `/v1/secrets-providers/${encodeURIComponent(ownerId)}`);
    return r.providers.map(providerViewOf);
  }
}
