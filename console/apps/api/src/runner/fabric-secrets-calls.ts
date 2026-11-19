// The secrets-provider calls a run makes through the browser host: their options and results, and the typed errors of a failed action.
import { SECRETS_ERROR_CODES, SecretsProviderError, type ItemKind, type ItemSummary, type SecretField, type SecretPurpose, type SecretsErrorCode, type SecretsProviderView } from '../secrets/secrets-provider.port';
import type { FabricOperation } from './fabric-handoff';

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

export interface WireItem {
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

export interface WireProviderView {
  owner_id: string;
  provider: string;
  kind: 'vault' | 'console' | 'test';
  base_url?: string;
  registered_at: string;
  expires_at?: string | null;
}

export function dateOf(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function itemOf(i: WireItem): ItemSummary {
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

export function providerViewOf(v: WireProviderView): SecretsProviderView {
  return { ownerId: v.owner_id, provider: v.provider, kind: v.kind, ...(v.base_url ? { baseUrl: v.base_url } : {}), registeredAt: new Date(v.registered_at), expiresAt: dateOf(v.expires_at) };
}

export function target(t: ProviderTarget): Record<string, unknown> {
  return t.selector !== undefined ? { selector: t.selector } : { point: { x: t.point.x, y: t.point.y } };
}

export function providerMeta(o: ProviderCallOptions): Record<string, unknown> {
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
