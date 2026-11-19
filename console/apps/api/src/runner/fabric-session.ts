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
import { traceFabric } from './agent-trace';

/** How long a run waits for a person who took over its browser (#342). */
export const TAKEOVER_WAIT_MS = 30 * 60_000;
const TAKEOVER_POLL_MS = 5_000;

/** The fabric refused because a person controls the host's desktop. */
export const isTakeoverActive = (e: unknown): e is FabricError => e instanceof FabricError && e.status === 409 && e.code === 'takeover_active';

/** An operation as the fabric reports it (fields the runner reads). */
export interface FabricOperation {
  id: string;
  state: 'queued' | 'dispatched' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
  result?: Record<string, unknown>;
  error?: string;
  /** Top-level navigations the browser blocked under the session's allowed sites since the previous action (#508). */
  navigation_blocked?: Array<{ host: string; at: string }>;
}

export type FabricHandoffInput = 'none' | 'text' | 'secret' | 'choice' | 'multi_choice' | 'number' | 'confirm' | 'takeover' | 'credentials';

/** The answer as the fabric reports it (`HandoffView.response`, snake_case). */
export interface FabricHandoffResponse {
  /** Absent on fabrics older than the typed contract (#285): derive it from the status. */
  outcome?: 'completed' | 'cancelled';
  value?: string;
  values?: string[];
  /** A secret (or a sign-in's password): it exists but is never returned; a `type_secret` action types it, once. */
  value_withheld?: boolean;
  /** The person's choice for the question's "remember me" option (#527). */
  remember?: boolean;
  channel?: string;
  by?: string;
  answered_at?: string;
}

export interface FabricHandoff {
  id: string;
  /** The fabric session it belongs to. */
  session_id?: string;
  status: 'pending' | 'completed' | 'cancelled' | 'expired';
  input: FabricHandoffInput;
  kind: string;
  prompt?: string;
  choices?: (string | { id: string; label: string; description?: string })[];
  page?: { url?: string; title?: string };
  viewer_url?: string;
  /** The site's "remember me" option offered with the question (#527). */
  remember?: { label: string };
  created_at?: string;
  expires_at?: string;
  resolved_at?: string;
  response?: FabricHandoffResponse;
}

/** How a resolved handoff ended: the response's outcome, or (older fabrics) its status. Null while pending or expired. */
export function handoffOutcome(h: Pick<FabricHandoff, 'status' | 'response'>): 'completed' | 'cancelled' | null {
  if (h.response?.outcome) return h.response.outcome;
  if (h.status === 'completed') return 'completed';
  if (h.status === 'cancelled') return 'cancelled';
  return null;
}

/** What a handoff asks, in the console's camelCase (mapped to the fabric's snake_case body). */
export interface HandoffRequest {
  kind: string;
  prompt: string;
  input: string;
  choices?: (string | { id: string; label: string; description?: string })[];
  constraints?: {
    maxLength?: number;
    pattern?: string;
    multiline?: boolean;
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
    minSelections?: number;
    maxSelections?: number;
  } | null;
  confirmLabel?: string | null;
  denyLabel?: string | null;
  risk?: 'low' | 'high' | null;
  /** credentials and secret: the site's "remember me" option, in the page's words (#527). */
  rememberLabel?: string | null;
  /**
   * credentials only (E37.4b): the fabric keeps the typed password in its memory after `type_secret` types it, for ten minutes
   * after the answer, so the owner's secrets provider can still be asked to save the sign-in (`saveLogin`). Never returned.
   */
  offerSave?: boolean;
  timeoutMs?: number;
}

/** A created handoff: its id and what the inbox shows. */
export interface CreatedHandoff {
  id: string;
  viewerUrl: string | null;
  pageTitle: string | null;
  expiresAt: Date | null;
}

const CONSTRAINT_FIELDS = {
  maxLength: 'max_length',
  pattern: 'pattern',
  multiline: 'multiline',
  min: 'min',
  max: 'max',
  step: 'step',
  unit: 'unit',
  minSelections: 'min_selections',
  maxSelections: 'max_selections',
} as const;

/**
 * A choice as the fabric takes it: a bare string when it is its own label
 * (what fabrics before the typed contract accept), else `{ id, label, description? }`.
 */
function fabricChoice(c: string | { id: string; label: string; description?: string }): string | { id: string; label: string; description?: string } {
  if (typeof c === 'string' || (c.id === c.label && !c.description)) return typeof c === 'string' ? c : c.id;
  return { id: c.id, label: c.label, ...(c.description ? { description: c.description } : {}) };
}

/** The fabric's create body. Typed-contract fields are sent only when set, so older fabrics keep accepting it. */
export function handoffBody(req: HandoffRequest): Record<string, unknown> {
  const constraints: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.constraints ?? {})) {
    if (v !== undefined) constraints[CONSTRAINT_FIELDS[k as keyof typeof CONSTRAINT_FIELDS]] = v;
  }
  return {
    kind: req.kind,
    prompt: req.prompt,
    input: req.input,
    choices: (req.choices ?? []).map(fabricChoice),
    ...(Object.keys(constraints).length ? { constraints } : {}),
    ...(req.confirmLabel ? { confirm_label: req.confirmLabel } : {}),
    ...(req.denyLabel ? { deny_label: req.denyLabel } : {}),
    ...(req.risk ? { risk: req.risk } : {}),
    ...(req.rememberLabel ? { remember: { label: req.rememberLabel } } : {}),
    ...(req.offerSave ? { offer_save: true } : {}),
    timeout_ms: req.timeoutMs,
  };
}

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
    return { id: h.id, viewerUrl: h.viewer_url ?? null, pageTitle: h.page?.title ?? null, expiresAt: expires && !Number.isNaN(expires.getTime()) ? expires : null };
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

/** What every provider call takes besides its subject. */
export interface ProviderCallOptions {
  /** Which provider to use when the owner has several. */
  provider?: string;
  runId?: string;
  /** What the owner sees as the app in the audit trail. */
  clientLabel?: string;
  /** Pin the tab; otherwise the active tab of the focused window. */
  tabId?: number;
  timeoutMs?: number;
  /** See {@link FabricSession.act}: wait out a person's takeover (default) or throw at once. */
  waitForTakeover?: boolean;
}

/** Where a typed value goes: exactly one of `selector` and `point`. */
export type ProviderTarget = { selector: string; point?: undefined } | { point: { x: number; y: number }; selector?: undefined };

export type TypeFromProviderOptions = ProviderCallOptions &
  ProviderTarget & {
    itemId: string;
    field: SecretField;
    purpose?: SecretPurpose;
    /** Clear the existing value first (default true). */
    clear?: boolean;
    /** Press Enter after typing (default false). */
    submit?: boolean;
  };

export type SelectFromProviderOptions = ProviderCallOptions & {
  itemId: string;
  field: SecretField;
  /** The `<select>` in the top-level document. */
  selector: string;
  /** For a date of birth in separate selects. */
  part?: 'day' | 'month' | 'year';
};

/** The card fields a `type_card_field` action types; `expiry` is one `MM/YY` input composed by the fabric. */
export const CARD_FIELDS = ['number', 'expiry', 'exp_month', 'exp_year', 'holder_name', 'postal_code', 'security_code'] as const;
export type CardFieldName = (typeof CARD_FIELDS)[number];

export type TypeCardFieldOptions = ProviderCallOptions &
  ProviderTarget & {
    itemId: string;
    field: CardFieldName;
    /** The purchase's amount: a decimal with at most two places. */
    amount: string;
    /** ISO 4217, upper case. */
    currency: string;
    /** Clear the existing value first (default true). */
    clear?: boolean;
  };

export type TypeCodeFromProviderOptions = ProviderCallOptions &
  ProviderTarget & {
    itemId: string;
    clear?: boolean;
    submit?: boolean;
  };

export interface SecretsLookupResult {
  /** The page's top-level origin as the browser reported it. */
  origin: string;
  /** The provider that answered. */
  provider: string;
  items: ItemSummary[];
}

interface WireItem {
  id: string;
  name: string;
  username?: string;
  origins?: string[];
  match_kind: 'exact' | 'site';
  has_code?: boolean;
  updated_at?: string | null;
  fields?: { key: SecretField; label?: string; sensitive?: boolean; usable_here?: boolean }[];
  card?: {
    brand?: string | null;
    last4?: string | null;
    exp_month?: string | null;
    exp_year?: string | null;
    grant?: { max_amount: string; currency: string; includes_security_code?: boolean; expires_at?: string | null } | null;
  };
}

interface WireProviderView {
  owner_id: string;
  provider: string;
  kind: 'vault' | 'console' | 'test';
  base_url?: string;
  registered_at: string;
  expires_at?: string | null;
}

function dateOf(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function itemOf(i: WireItem): ItemSummary {
  return {
    id: i.id,
    name: i.name,
    ...(i.username !== undefined ? { username: i.username } : {}),
    origins: i.origins ?? [],
    matchKind: i.match_kind,
    hasCode: i.has_code ?? false,
    updatedAt: dateOf(i.updated_at),
    ...(i.fields ? { fields: i.fields.map((f) => ({ key: f.key, label: f.label ?? String(f.key), sensitive: f.sensitive === true, usableHere: f.usable_here === true })) } : {}),
    ...(i.card
      ? {
          card: {
            brand: i.card.brand ?? null,
            // At most the last four digits ever cross this boundary; a longer text is dropped, not trimmed.
            last4: i.card.last4 && /^\d{1,4}$/.test(i.card.last4) ? i.card.last4 : null,
            expMonth: i.card.exp_month ?? null,
            expYear: i.card.exp_year ?? null,
            grant: i.card.grant ? { maxAmount: i.card.grant.max_amount, currency: i.card.grant.currency, includesSecurityCode: i.card.grant.includes_security_code === true, expiresAt: dateOf(i.card.grant.expires_at) } : null,
          },
        }
      : {}),
  };
}

function providerViewOf(v: WireProviderView): SecretsProviderView {
  return { ownerId: v.owner_id, provider: v.provider, kind: v.kind, ...(v.base_url ? { baseUrl: v.base_url } : {}), registeredAt: new Date(v.registered_at), expiresAt: dateOf(v.expires_at) };
}

function target(t: ProviderTarget): Record<string, unknown> {
  return t.selector !== undefined ? { selector: t.selector } : { point: { x: t.point.x, y: t.point.y } };
}

function providerMeta(o: ProviderCallOptions): Record<string, unknown> {
  return {
    ...(o.provider ? { provider: o.provider } : {}),
    ...(o.runId ? { run_id: o.runId } : {}),
    ...(o.clientLabel ? { client_label: o.clientLabel } : {}),
    ...(o.tabId !== undefined ? { tab_id: o.tabId } : {}),
  };
}

/**
 * The result of a provider action, or the typed error it failed with. A failed
 * operation's `error` is `<code>: <message>`; a timed-out or cancelled one has
 * no code of its own. The message never carries a value.
 */
export function secretsResult(op: FabricOperation): Record<string, unknown> {
  if (op.state === 'succeeded') return op.result ?? {};
  if (op.state === 'timed_out') throw new SecretsProviderError('timed_out', op.error ?? 'The action timed out', undefined, op.id);
  if (op.state === 'cancelled') throw new SecretsProviderError('cancelled', op.error ?? 'The action was cancelled', undefined, op.id);
  throw secretsErrorOf(op);
}

/** `<code>: <message>` to a {@link SecretsProviderError}; an unknown code is `unknown` (the text is kept). */
export function secretsErrorOf(op: Pick<FabricOperation, 'id' | 'error'>): SecretsProviderError {
  const text = op.error ?? 'The provider action failed';
  const m = /^([a-z_]+): ([\s\S]*)$/.exec(text);
  const code = m && (SECRETS_ERROR_CODES as readonly string[]).includes(m[1]!) ? (m[1] as SecretsErrorCode) : 'unknown';
  const message = m && code !== 'unknown' ? m[2]! : text;
  const retry = code === 'rate_limited' ? /retry in (\d+) s/.exec(message) : null;
  return new SecretsProviderError(code, message, retry ? Number(retry[1]) : undefined, op.id);
}
