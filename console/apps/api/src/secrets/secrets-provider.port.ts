import { inspect } from 'node:util';

/**
 * The secrets provider port (epic #579, issue #590).
 *
 * A stored secret gets from a provider (Vault, the built-in store) into a page
 * like this: the agent names which item and field ("the password of this
 * login"); the fabric asks the owner's provider for the value with the page's
 * origin, types it with trusted input and wipes it. The model, the console's
 * database, logs, traces, screenshots and exports never hold it.
 *
 * Two kinds of provider exist:
 *  - one the fabric calls itself over the network (Vault): the console only
 *    registers it with the fabric (`FabricSession.registerSecretsProvider`)
 *    and refreshes its token; it never sees a value;
 *  - one that lives in the console because it has no address of its own (the
 *    built-in store, E37.5): it implements {@link SecretsProviderPort}, and the
 *    fabric calls back to an authenticated, loopback-or-TLS internal route that
 *    returns one field with `Cache-Control: no-store`.
 *
 * The rules of Vault's "Holding a value" apply to every implementation:
 * memory only, never in a log line, span, metric label, event, database row or
 * error message, zeroed after use on success, failure and cancellation.
 */

/** What a provider stores. Only `login` is implemented by the first providers. */
export type ItemKind = 'login' | 'identity' | 'card';

/** One field of one item. A provider releases a single field per call. */
export type SecretField =
  | 'username'
  | 'password'
  | 'full_name'
  | 'date_of_birth'
  | 'id_type'
  | 'id_number'
  | 'id_issuing_country'
  | 'address_line1'
  | 'address_line2'
  | 'city'
  | 'region'
  | 'postal_code'
  | 'country'
  | 'phone'
  | 'email'
  | 'card_number'
  | 'exp_month'
  | 'exp_year'
  | 'holder_name'
  | 'security_code';

/** Why a value is released; recorded for the owner. */
export type SecretPurpose = 'login' | 'signup' | 'password_change' | 'mfa' | 'form' | 'purchase' | 'save_login';

/** `exact`: one of the item's origins equals the page's. `site`: same registrable domain only; never fillable. */
export type MatchKind = 'exact' | 'site';

/** One field of an identity item as a lookup lists it (E37.6): a label and two flags, never a value or a length. */
export interface FieldSummary {
  key: SecretField;
  /** What the owner calls it ("Date of birth"). */
  label: string;
  /** Released only to a site on the item's allowed list (exact origin). */
  sensitive: boolean;
  /** A fill on the page the lookup was for would be allowed: not sensitive, or the page's origin is on the list. */
  usableHere: boolean;
}

/** The grant a card is listed under for the merchant on screen (E37.7): what the owner allowed in the provider. */
export interface CardGrantSummary {
  /** The most a purchase may be, a decimal with two places (`"500.00"`). */
  maxAmount: string;
  /** ISO 4217. */
  currency: string;
  /** The security code may be released under this grant. */
  includesSecurityCode: boolean;
  expiresAt?: Date | null;
}

/** What a lookup says about a saved card (E37.7). Never the number, never the security code: the last four digits at most. */
export interface CardSummary {
  brand?: string | null;
  last4?: string | null;
  expMonth?: string | null;
  expYear?: string | null;
  grant?: CardGrantSummary | null;
}

/** What a provider says about an item the owner opened to the agent. Never a value (a login's username is not secret). */
export interface ItemSummary {
  id: string;
  name: string;
  username?: string;
  /** `scheme://host[:port]` each. */
  origins: string[];
  matchKind: MatchKind;
  /** A one-time code can be produced for the item. */
  hasCode: boolean;
  updatedAt?: Date | null;
  /** An identity item's fields (E37.6); absent for a login. For an identity item `matchKind` is `exact` when the page's origin is on the item's allowed list. */
  fields?: FieldSummary[];
  /** A saved card (E37.7): brand, last four, expiry and the merchant grant it is listed under; absent for a login and an identity item. */
  card?: CardSummary;
}

/** One field of one item, for one purpose, bound to the page's origin (read by the fabric from the browser). */
export interface ReleaseRequest {
  ownerId: string;
  itemId: string;
  field: SecretField;
  /** Normalised `scheme://host[:port]`: exactly one of the item's origins, or the provider answers `origin_mismatch`. */
  origin: string;
  purpose: SecretPurpose;
  runId?: string;
  /** What the owner sees as the app. */
  clientLabel?: string;
}

/**
 * A key of an outside service (E50.3, #973; decision record `docs/decisions/web-search.md` §3): item kind `api_key`, a `service` and a
 * `name`, one value, no origin. It is a separate kind on purpose: it is NOT an {@link ItemKind}, so no lookup by a page, no fabric
 * call and no saved-login tool can name one. Only the console's own server process asks for it, through the service credentials port.
 */
export const SERVICE_KEY_ITEM_KIND = 'api_key' as const;

/** One key of an outside service, for the console's own call to that service. Nothing from a model or a page chooses `service` or `name`. */
export interface ServiceKeyRequest {
  ownerId: string;
  /** `web_search`. */
  service: string;
  /** `brave`. */
  name: string;
  /** A server-side call to the service (Vault's `AGENT_SERVICE_KEY_PURPOSE`). */
  purpose: 'service_call';
  runId?: string;
}

export interface CodeRequest {
  ownerId: string;
  itemId: string;
  origin: string;
  purpose: SecretPurpose;
  runId?: string;
  clientLabel?: string;
}

/**
 * Bytes that do not leak by accident: no string form, no JSON form, hidden
 * from `util.inspect` (so from `console.log` and from error reporters), wiped
 * on demand. Prefer {@link SecretBytes.take} with a buffer you own: a JS string
 * cannot be wiped, so {@link SecretBytes.from} on one only narrows how long
 * the copy lives.
 */
export class SecretBytes {
  #bytes: Buffer | null;

  private constructor(bytes: Buffer) {
    this.#bytes = bytes;
  }

  /** Take ownership of `bytes` (no copy). */
  static take(bytes: Buffer): SecretBytes {
    return new SecretBytes(bytes);
  }

  /** Copy a string or bytes. */
  static from(value: string | Uint8Array): SecretBytes {
    return new SecretBytes(typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value));
  }

  /** Run `fn` on the bytes. Whatever it returns must not hold them. */
  expose<R>(fn: (bytes: Buffer) => R): R {
    if (!this.#bytes) throw new Error('The secret was already wiped');
    return fn(this.#bytes);
  }

  /** Overwrite the bytes with zeros. Idempotent. */
  wipe(): void {
    this.#bytes?.fill(0);
    this.#bytes = null;
  }

  get wiped(): boolean {
    return this.#bytes === null;
  }

  toString(): string {
    return '[secret]';
  }

  toJSON(): string {
    return '[secret]';
  }

  [inspect.custom](): string {
    return '[secret]';
  }
}

/** Why a provider did not answer: the codes of the fabric's `provider_error_codes`. */
export type SecretsErrorCode =
  | 'no_provider'
  | 'provider_required'
  | 'not_found'
  | 'origin_mismatch'
  | 'disabled'
  | 'rate_limited'
  | 'unavailable'
  | 'unauthorized'
  | 'refused'
  | 'origin_unavailable'
  | 'cross_origin_frame'
  | 'typing_failed'
  | 'insecure_origin'
  | 'no_option'
  | 'amount_exceeded'
  | 'currency_mismatch'
  | 'security_code_not_granted'
  | 'grant_expired'
  | 'limit_reached'
  | 'cards_disabled'
  | 'frame_unknown'
  | 'target_not_password'
  /** Saving a login (E37.4b): the owner already has a secret with that name. */
  | 'name_taken'
  /** Saving a login: the fabric no longer holds the password (saved, expired, restarted): too late. */
  | 'secret_unavailable'
  | 'unsupported'
  /** Hexactra passkeys (E47.4): the page asked for no passkey after the click. */
  | 'no_request'
  /** No Hexactra passkey of the owner fits the page (the browser shows its own prompt). */
  | 'no_passkey'
  /** Several of the owner's passkeys fit: the owner chooses the account. */
  | 'several_passkeys'
  /** A payment approval (Secure Payment Confirmation): never made by Hexactra (E47.6). */
  | 'payment_refused'
  /** The site wants a passkey type Hexactra does not make (only ES256). */
  | 'unsupported_algorithm'
  /** This account on the site already has the owner's Hexactra passkey. */
  | 'already_registered'
  /** The page's passkey request is not usable. */
  | 'invalid_request'
  | 'timed_out'
  | 'cancelled'
  | 'unknown';

export const SECRETS_ERROR_CODES: readonly SecretsErrorCode[] = [
  'no_provider',
  'provider_required',
  'not_found',
  'origin_mismatch',
  'disabled',
  'rate_limited',
  'unavailable',
  'unauthorized',
  'refused',
  'origin_unavailable',
  'cross_origin_frame',
  'typing_failed',
  'insecure_origin',
  'no_option',
  'amount_exceeded',
  'currency_mismatch',
  'security_code_not_granted',
  'grant_expired',
  'limit_reached',
  'cards_disabled',
  'frame_unknown',
  'target_not_password',
  'name_taken',
  'secret_unavailable',
  'unsupported',
  'no_request',
  'no_passkey',
  'several_passkeys',
  'payment_refused',
  'unsupported_algorithm',
  'already_registered',
  'invalid_request',
  'timed_out',
  'cancelled',
  'unknown',
];

/**
 * What a run should do about an error (Vault's guide, "Holding a value" 6 and
 * "Recommended flow"):
 *  - `stop`: end the step and tell the person; never retry (a look-alike site, a switched-off provider);
 *  - `ask_person`: no usable item or provider; ask the person, do not guess;
 *  - `reconnect`: the provider's token was refused; the owner must connect it again;
 *  - `wait`: retry after `retryAfterSeconds`, once;
 *  - `retry_later`: the provider or browser had a transient failure; one retry is fine;
 *  - `fail`: the step cannot be done this way.
 */
export type SecretsErrorAction = 'stop' | 'ask_person' | 'reconnect' | 'wait' | 'retry_later' | 'fail';

export function secretsErrorAction(code: SecretsErrorCode): SecretsErrorAction {
  switch (code) {
    case 'origin_mismatch':
    case 'cross_origin_frame':
    case 'frame_unknown':
    case 'disabled':
    case 'cards_disabled':
      return 'stop';
    case 'not_found':
    case 'no_provider':
    case 'provider_required':
    case 'target_not_password':
      return 'ask_person';
    case 'unauthorized':
      return 'reconnect';
    case 'rate_limited':
      return 'wait';
    case 'unavailable':
    case 'timed_out':
    case 'typing_failed':
      return 'retry_later';
    default:
      return 'fail';
  }
}

/**
 * A secrets provider action failed. `message` is the fabric's text and never
 * carries a value; branch on `code`, not on the message.
 */
export class SecretsProviderError extends Error {
  constructor(
    readonly code: SecretsErrorCode,
    message: string,
    /** For `rate_limited`: when to try again. */
    readonly retryAfterSeconds?: number,
    /** The fabric operation that failed, for the audit trail. */
    readonly operationId?: string,
  ) {
    super(message);
    this.name = 'SecretsProviderError';
  }

  get action(): SecretsErrorAction {
    return secretsErrorAction(this.code);
  }
}

/**
 * A provider that lives in the console (the built-in store, E37.5): the same
 * three calls the fabric makes of any provider. Throw {@link SecretsProviderError}
 * for a refusal; its `code` is what the fabric reports. Implementations must
 * answer an item that is missing, not the owner's or not opened to the agent
 * with one identical `not_found`, and must bind every release to the exact
 * origin.
 */
export interface SecretsProviderPort {
  /** `builtin`: the id actions name. */
  readonly id: string;
  /** Items the owner opened to the agent for this origin, exact matches first. Never a value. */
  lookup(ownerId: string, origin: string, kind: ItemKind): Promise<ItemSummary[]>;
  /** One field of one item. The caller wipes the result. */
  release(req: ReleaseRequest): Promise<SecretBytes>;
  /** A one-time code and when it expires. The caller wipes the value. */
  oneTimeCode(req: CodeRequest): Promise<{ value: SecretBytes; expiresAt: Date }>;
  /**
   * The value of a key of an outside service (E50.3): for the console API process only, from the service credentials port, never
   * from the fabric or a tool. Optional: a provider without it cannot hold service keys. The caller wipes the result.
   */
  releaseServiceKey?(req: ServiceKeyRequest): Promise<SecretBytes>;
}

/** What the console tells the fabric about an owner's provider. The token is Secret Material: write only. */
export interface SecretsProviderRegistration {
  /** The id actions name: `vault`, `builtin`, `test`. */
  provider: string;
  kind: 'vault' | 'console' | 'test';
  /** Where the provider is (`https`, or `http` on loopback). */
  baseUrl?: string;
  /** The access token the provider takes; held in the fabric's memory only. */
  accessToken?: string;
  /** When the token stops working; the fabric drops the registration then. */
  expiresAt?: Date;
  /** Provider-specific, non-secret settings. */
  settings?: Record<string, unknown>;
}

/** A registration as the fabric reports it: never the token. */
export interface SecretsProviderView {
  ownerId: string;
  provider: string;
  kind: 'vault' | 'console' | 'test';
  baseUrl?: string;
  registeredAt: Date;
  expiresAt?: Date | null;
}
