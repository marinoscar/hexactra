// What the console keeps of one `secrets.*` audit event of the fabric (E37.4, #593).
//
// The fabric emits `secrets.lookup` and `secrets.release` for every provider action (crates/hexactra-control,
// runtime/secrets.rs `Audit::emit`): who, which run, provider, item, field, origin, purpose, how it ended. It says
// "never the value", and this module does not rely on that: it COPIES a whitelist of fields out of the payload and
// validates each one against a closed set or a strict pattern; everything else in the payload (a field that does not
// exist today, a message, a username, a URL path) is dropped before anything reaches the database. A value that does
// not fit its pattern becomes `null` (or `other` for an outcome), never a truncated copy of the text.
import { hostOf } from './secrets.events';

/** The audit events the Activity list is made of. */
export const SECRETS_ACTIVITY_EVENTS = ['secrets.lookup', 'secrets.release'] as const;
export type SecretsActivityEvent = 'lookup' | 'release';

/** The field kinds a release may name. */
export const ACTIVITY_FIELDS = [
  'username',
  'password',
  'one_time_code',
  // Identity details (E37.6): the field kind, never a value.
  'full_name',
  'date_of_birth',
  'id_type',
  'id_number',
  'id_issuing_country',
  'address_line1',
  'address_line2',
  'city',
  'region',
  'postal_code',
  'country',
  'phone',
  'email',
  // Card fields (E37.7): the field kind, never a value.
  'number',
  'expiry',
  'exp_month',
  'exp_year',
  'holder_name',
  'security_code',
] as const;
/** The purposes the fabric sends (Vault's `purpose` for fill and totp). */
export const ACTIVITY_PURPOSES = ['login', 'signup', 'password_change', 'mfa', 'form', 'purchase'] as const;
/**
 * The closed outcome codes of the fabric (`typed` and `ok` for success, the rest are `Fail` codes of
 * runtime/secrets.rs). Anything else is stored as `other`.
 */
export const ACTIVITY_OUTCOMES = [
  'typed',
  'selected',
  'ok',
  'no_provider',
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
  // Card refusals (E37.7).
  'amount_exceeded',
  'currency_mismatch',
  'security_code_not_granted',
  'grant_expired',
  'limit_reached',
  'cards_disabled',
  'frame_unknown',
  // A login's password named a field that is not a password field (E37.10).
  'target_not_password',
  'timed_out',
  'internal',
  'other',
] as const;
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];

/** An outcome that is the fabric refusing or failing, not a success. */
export const isRefusal = (outcome: string): boolean => outcome !== 'typed' && outcome !== 'selected' && outcome !== 'ok';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A provider item id: the characters of a uuid or a short slug, nothing that could be text. */
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/;
const PROVIDER = /^[a-z][a-z0-9_-]{0,19}$/;

/** A row to write: every column is a validated copy. */
export interface SanitizedActivity {
  userId: string;
  occurredAt: Date;
  event: SecretsActivityEvent;
  opId: string;
  /** Only a UUID can be a run; whether it exists is checked at write time. */
  runId: string | null;
  provider: string;
  itemId: string | null;
  field: (typeof ACTIVITY_FIELDS)[number] | null;
  site: string | null;
  purpose: (typeof ACTIVITY_PURPOSES)[number] | null;
  outcome: ActivityOutcome;
  matches: number | null;
  released: boolean;
  /** A card field (E37.7): the purchase's amount (a decimal with at most two places), its currency and the payment frame's host. Null otherwise. */
  amount: string | null;
  currency: string | null;
  frameSite: string | null;
}

const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const oneOf = <T extends string>(set: readonly T[], v: unknown): T | null => (typeof v === 'string' && (set as readonly string[]).includes(v) ? (v as T) : null);

/** The host of the page an event names: from an origin URL, never a path, query or user info; null unless it is a plain host. */
export function siteOf(origin: unknown): string | null {
  const raw = asString(origin);
  if (!raw || raw.length > 2048) return null;
  const host = hostOf(raw)?.toLowerCase() ?? null;
  return host && host.length <= 255 && HOST.test(host) ? host : null;
}

const AMOUNT = /^\d{1,8}(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;

/** One fabric event (`{ seq, type, at, data }`) as a row, or `null` when it is not a usable activity event. */
export function sanitizeSecretsEvent(raw: unknown): SanitizedActivity | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as { type?: unknown; at?: unknown; data?: unknown };
  const event: SecretsActivityEvent | null = e.type === 'secrets.lookup' ? 'lookup' : e.type === 'secrets.release' ? 'release' : null;
  if (!event || !e.data || typeof e.data !== 'object') return null;
  const d = e.data as Record<string, unknown>;

  const userId = asString(d.owner_id);
  const opId = asString(d.op_id);
  if (!userId || !UUID.test(userId) || !opId || !UUID.test(opId)) return null;
  const at = typeof e.at === 'string' ? new Date(e.at) : null;
  if (!at || Number.isNaN(at.getTime())) return null;

  const providerRaw = asString(d.provider);
  const itemRaw = asString(d.item_id);
  const runRaw = asString(d.run_id);
  const matches = typeof d.count === 'number' && Number.isInteger(d.count) && d.count >= 0 && d.count <= 10_000 ? d.count : null;
  return {
    userId: userId.toLowerCase(),
    occurredAt: at,
    event,
    opId: opId.toLowerCase(),
    runId: runRaw && UUID.test(runRaw) ? runRaw.toLowerCase() : null,
    provider: providerRaw && PROVIDER.test(providerRaw) ? providerRaw : 'unknown',
    itemId: event === 'release' && itemRaw && ITEM_ID.test(itemRaw) ? itemRaw : null,
    field: event === 'release' ? oneOf(ACTIVITY_FIELDS, d.field) : null,
    site: siteOf(d.origin),
    purpose: event === 'release' ? oneOf(ACTIVITY_PURPOSES, d.purpose) : null,
    outcome: oneOf(ACTIVITY_OUTCOMES, d.outcome) ?? 'other',
    matches: event === 'lookup' ? matches : null,
    released: d.released === true,
    amount: event === 'release' && typeof d.amount === 'string' && AMOUNT.test(d.amount) ? d.amount : null,
    currency: event === 'release' && typeof d.currency === 'string' && CURRENCY.test(d.currency) ? d.currency : null,
    frameSite: event === 'release' ? siteOf(d.frame_origin) : null,
  };
}

/** How long an activity row is kept. */
export const SECRETS_ACTIVITY_KEEP_DAYS = 180;
