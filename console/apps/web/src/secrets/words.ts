// Plain words for the Secrets pages (E37.4, #593): what a granted scope lets the agent do, what a field kind is, and
// what an outcome code of the fabric means to an owner.
import type { ActivityField, ActivityItem } from './api';

export const SCOPE_WORDS: Record<string, string> = {
  'vault:items_read': 'Find your logins',
  'vault:items_fill': 'Type them for you',
  'vault:items_write': 'Save and change logins',
  'vault:identity_read': 'See which identity details you saved',
  'vault:identity_fill': 'Fill them into forms for you',
};

/** The granted permissions in plain words, in the order the owner would read them; scopes that are not permissions (`offline_access`) are left out. */
export function permissionWords(scopes: readonly string[]): string[] {
  return Object.keys(SCOPE_WORDS)
    .filter((s) => scopes.includes(s))
    .map((s) => SCOPE_WORDS[s]!);
}

export const hasWriteScope = (scopes: readonly string[]): boolean => scopes.includes('vault:items_write');
export const hasIdentityScope = (scopes: readonly string[]): boolean => scopes.includes('vault:identity_read') && scopes.includes('vault:identity_fill');

const FIELD_WORDS: Record<ActivityField, string> = {
  username: 'username',
  password: 'password',
  one_time_code: 'code',
  full_name: 'full name',
  date_of_birth: 'date of birth',
  id_type: 'ID type',
  id_number: 'ID number',
  id_issuing_country: 'ID issuing country',
  address_line1: 'address',
  address_line2: 'address line 2',
  city: 'city',
  region: 'region',
  postal_code: 'postal code',
  country: 'country',
  phone: 'phone number',
  email: 'email address',
};

const IDENTITY_FIELDS: readonly ActivityField[] = ['full_name', 'date_of_birth', 'id_type', 'id_number', 'id_issuing_country', 'address_line1', 'address_line2', 'city', 'region', 'postal_code', 'country', 'phone', 'email'];

/** "username and password", "code": the fields typed, in words (a list of kinds). */
export function fieldsWords(fields: readonly ActivityField[]): string {
  const words = fields.map((f) => FIELD_WORDS[f]);
  if (words.length === 0) return 'nothing yet';
  if (words.length === 1) return words[0]!;
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)!}`;
}

/** What the agent did, for one activity row. */
export function whatWords(item: Pick<ActivityItem, 'event' | 'field' | 'matches'> & { outcome?: string }): string {
  if (item.event === 'lookup') {
    if (item.matches === null) return 'Looked for a saved login';
    return item.matches === 0 ? 'Looked for a saved login: none found' : `Looked for a saved login: ${item.matches} found`;
  }
  if (item.field && IDENTITY_FIELDS.includes(item.field)) return item.outcome === 'selected' ? `Chose the ${FIELD_WORDS[item.field]}` : `Filled the ${FIELD_WORDS[item.field]}`;
  return item.field ? `Typed the ${FIELD_WORDS[item.field]}` : 'Typed a field';
}

const OUTCOME_WORDS: Record<string, string> = {
  typed: 'Typed',
  selected: 'Chosen',
  insecure_origin: 'Refused: the page does not use https',
  no_option: 'Failed: no option matched',
  ok: 'Done',
  no_provider: 'Refused: no provider was connected',
  not_found: 'Refused: no saved login for this page',
  origin_mismatch: 'Refused: the page was not the saved site',
  cross_origin_frame: 'Refused: the field was in a frame of another site',
  disabled: 'Refused: saved logins are turned off',
  rate_limited: 'Refused: too many requests, try again later',
  unavailable: 'Failed: the provider could not be reached',
  unauthorized: 'Failed: the provider asks you to connect again',
  refused: 'Refused by the provider',
  origin_unavailable: 'Failed: the page address could not be read',
  typing_failed: 'Failed: the field could not be typed into',
  timed_out: 'Failed: it took too long',
  internal: 'Failed: something went wrong',
  other: 'Failed',
};

export function outcomeWords(outcome: string): string {
  return OUTCOME_WORDS[outcome] ?? OUTCOME_WORDS.other!;
}

/** The result of coming back from the provider's consent screen (`?vault=` on the page). */
export const CONNECT_RESULT_WORDS: Record<string, { severity: 'success' | 'warning' | 'error'; text: string }> = {
  connected: { severity: 'success', text: 'Vault is connected.' },
  denied: { severity: 'warning', text: 'You did not approve the connection in Vault. Nothing was connected.' },
  expired: { severity: 'warning', text: 'The connection took too long. Try again.' },
  state_invalid: { severity: 'error', text: 'The connection could not be checked. Start it again from this page.' },
  binding_invalid: { severity: 'error', text: 'The connection must finish in the same browser that started it. Start it again from this page.' },
  issuer_mismatch: { severity: 'error', text: 'The answer did not come from the Vault you chose. Nothing was connected.' },
  exchange_failed: { severity: 'error', text: 'Vault did not accept the connection. Check the client id and secret, and try again.' },
  no_refresh_token: { severity: 'error', text: 'Vault did not allow a lasting connection. Ask its administrator to allow refresh tokens for Hexactra.' },
  whoami_failed: { severity: 'error', text: 'Vault connected but did not identify your account. Try again.' },
  refused: { severity: 'error', text: 'Vault refused the connection.' },
};
