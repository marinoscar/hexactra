// Signing in from a saved login (E37.3, #592). Pure functions and types: no I/O, no clock, no Nest.
//
// The model never names a secret or a provider id. It looks up the page it is on (`saved_logins`), gets short
// per-run references (`login-1`), and passes one back to `sign_in_with_saved_login` / `type_saved_code`; the
// fabric reads the page's origin itself when it types. What lands in a step, the run's memory or a tool result is
// a login's NAME, its masked username and its origin: never a password, a code or a provider id the model sees.
import { maskSensitive } from '../tasks/mask';
import type { ItemSummary, SecretsErrorCode } from '../secrets/secrets-provider.port';

/** One saved login a run signed in with, as `runs.used_saved_logins` stores it. */
export interface UsedSavedLogin {
  provider: string;
  /** The item's name as the owner gave it. Never its username. */
  itemName: string;
  /** `scheme://host[:port]` of the page it was used on. */
  origin: string;
  /** ISO time of its first use in the run. */
  at: string;
}

/** At most this many entries per run. */
export const MAX_USED_SAVED_LOGINS = 20;

/** Read `runs.used_saved_logins`: malformed entries are dropped. */
export function readUsedSavedLogins(value: unknown): UsedSavedLogin[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is UsedSavedLogin => !!v && typeof v === 'object' && typeof v.provider === 'string' && typeof v.itemName === 'string' && typeof v.origin === 'string' && typeof v.at === 'string')
    .map((v) => ({ provider: v.provider, itemName: v.itemName, origin: v.origin, at: v.at }));
}

/** The list with one more use, unless that login on that origin is already there (the oldest twenty are kept). */
export function appendUsedSavedLogin(current: unknown, entry: { provider: string; itemName: string; origin: string; at: Date }): UsedSavedLogin[] {
  const list = readUsedSavedLogins(current);
  if (list.some((u) => u.provider === entry.provider && u.itemName === entry.itemName && u.origin === entry.origin)) return list;
  if (list.length >= MAX_USED_SAVED_LOGINS) return list;
  return [...list, { provider: entry.provider.slice(0, 20), itemName: entry.itemName.slice(0, 200), origin: entry.origin.slice(0, 300), at: entry.at.toISOString() }];
}

/** `p•••@example.test` for an email address, `p•••` for any other name: enough for the owner to recognise it. */
export function maskUsername(username: string | undefined | null): string {
  const u = (username ?? '').trim();
  if (!u) return 'not shown';
  const at = u.lastIndexOf('@');
  if (at > 0) return `${u[0]}•••${u.slice(at)}`;
  return u.length > 1 ? `${u[0]}•••` : '•••';
}

/** What a step or the log may say about a login: its name (masked like any text of the trace) and the masked username. */
export function loginLabel(name: string, username: string | undefined | null): string {
  return `'${maskSensitive(name.replace(/\s+/g, ' ').trim().slice(0, 80)).text}' (username ${maskUsername(username)})`;
}

/** A login as the model reads it: a per-run reference, never the provider's id. */
export interface LookedUpLogin {
  ref: string;
  /** The provider's id for the item. Kept in the run's memory to map a reference back; never shown to the model. */
  itemId: string;
  name: string;
  username: string | null;
  exact: boolean;
  hasCode: boolean;
}

/** The lookup of the page the model is on. */
export interface SavedLoginLookup {
  /** The page's top-level origin as the browser reported it. */
  origin: string;
  provider: string;
  logins: LookedUpLogin[];
  /** More than one exact match: the owner picks one (`chosen`) before the run signs in. */
  ambiguous: boolean;
  /** The reference the owner picked from an ambiguous lookup. */
  chosen?: string | null;
}

/** The field-level phases of one sign-in attempt (crash safety): a field is `typing` before the call and `typed` after it. */
export type FieldPhase = 'typing' | 'typed';

/** What a run remembers about saved logins between chunks and jobs (`runs.transcript.savedLogins`). Never a value. */
export interface SavedLoginsMemory {
  /** References handed out so far, by the provider's item id: one reference per item per run. */
  refs: Record<string, string>;
  lookup?: SavedLoginLookup | null;
  /** The sign-in attempt in progress: which fields were typed. Cleared by a new lookup or when the attempt is done. */
  attempt?: { ref: string; itemId: string; username?: FieldPhase; password?: FieldPhase; code?: FieldPhase } | null;
  /** `<itemId>@<origin>` whose password was typed in this run: it is never typed twice. */
  passwordTyped?: string[];
  /** One-time codes typed per `<itemId>@<origin>`: a code is tried at most `MAX_CODE_TRIES` times. */
  codes?: Record<string, number>;
  /** A page refused a login as the wrong site: saved logins are off for the rest of the run. */
  stopped?: boolean;
}

/** A one-time code is typed at most this many times per login and site in a run. */
export const MAX_CODE_TRIES = 3;

/** The reference of an item in this run, handing out the next one (`login-1`, `login-2`, …) the first time. */
export function refFor(memory: SavedLoginsMemory, itemId: string): string {
  const known = memory.refs[itemId];
  if (known) return known;
  const ref = `login-${Object.keys(memory.refs).length + 1}`;
  memory.refs[itemId] = ref;
  return ref;
}

/** A provider's items for a page as the lookup the model reads and the runner remembers. Exact matches first. */
export function lookupOf(memory: SavedLoginsMemory, result: { origin: string; provider: string; items: ItemSummary[] }): SavedLoginLookup {
  const logins: LookedUpLogin[] = result.items
    .filter((i) => i.matchKind === 'exact' || i.matchKind === 'site')
    .map((i) => ({ ref: refFor(memory, i.id), itemId: i.id, name: i.name, username: i.username ?? null, exact: i.matchKind === 'exact', hasCode: i.hasCode }))
    .sort((a, b) => Number(b.exact) - Number(a.exact));
  const exact = logins.filter((l) => l.exact);
  return { origin: result.origin, provider: result.provider, logins, ambiguous: exact.length > 1, chosen: null };
}

/** The model-facing form of one login: `{ ref, name, username, exact, hasCode }`. */
export function loginForModel(l: LookedUpLogin) {
  return { ref: l.ref, name: l.name.slice(0, 120), username: l.username, exact: l.exact, hasCode: l.hasCode };
}

/** What `saved_logins` tells the model about a page. */
export function lookupText(lookup: SavedLoginLookup): string {
  const exact = lookup.logins.filter((l) => l.exact);
  if (lookup.logins.length === 0) {
    return 'none: no saved login for this page. Ask the owner to sign in: call request_human with kind "login", input "credentials".';
  }
  const list = JSON.stringify(lookup.logins.map(loginForModel));
  if (exact.length === 0) {
    return `${list}\nNone of these is saved for this exact address (only for other addresses of this site), so none may be used. Ask the owner to sign in: call request_human with kind "login", input "credentials".`;
  }
  if (exact.length === 1) {
    const only = exact[0]!;
    return `${list}\nExactly one login is saved for this address. Sign in with sign_in_with_saved_login(ref "${only.ref}")${only.hasCode ? `; if the site then asks for an authenticator-app code, use type_saved_code(ref "${only.ref}")` : ''}.`;
  }
  const options = exact.map((l) => ({ id: l.ref, label: `${l.name}${l.username ? ` (${l.username})` : ''}`.slice(0, 100) }));
  return `${list}\nSeveral logins are saved for this address: do not pick one yourself. Ask the owner: call request_human with kind "login", input "choice" and these options (the ids are the references): ${JSON.stringify(options)}. After they choose, sign in with the reference they chose.`;
}

/** How a provider failure reads to the model, and what the run does about it. */
export interface SavedLoginFailure {
  /** The words the model reads. */
  text: string;
  /** The run asks the owner now, with a warning card. */
  warn: boolean;
  /**
   * The run asks the owner now to sign in themselves (a takeover card, no warning): the fabric refused the field the model
   * named because it is not a password field (E37.10). Saved logins stay on; the model is told not to type the password itself.
   */
  askOwner?: boolean;
  /** The kind of step the failure is recorded as (`ok: false`). */
  summary: string;
  /** Provider outcome for the connection's status (`UNAUTHORIZED`, `DISABLED`, ...): null for a failure that says nothing about the provider. */
  outcome: string | null;
}

const ASK = 'Ask the owner to sign in: call request_human with kind "login", input "credentials".';
const UNAVAILABLE = `Saved logins are not available right now. ${ASK}`;

/** The error to instruction table (issue #592). Never carries the provider's message beyond what is written here. */
export function failureOf(code: SecretsErrorCode, retryAfterSeconds?: number): SavedLoginFailure {
  switch (code) {
    case 'origin_mismatch':
    case 'cross_origin_frame':
      return {
        text: code === 'origin_mismatch'
          ? 'Stop. This page is not the site this login is saved for. Do not try another login. Tell the owner.'
          : 'Stop. This field is in an embedded frame from another site, so nothing may be typed into it from a saved login. Do not try another login. Tell the owner.',
        warn: true,
        summary: code === 'origin_mismatch' ? 'the page is not the site this login is saved for: nothing was typed' : 'the field is in a frame of another site: nothing was typed',
        outcome: code === 'origin_mismatch' ? 'ORIGIN_MISMATCH' : null,
      };
    case 'target_not_password':
      return {
        text: 'The password was not typed: that field is not a password field, and a saved password is only typed into one. Do not type the password yourself and do not try other fields of the page. The owner has been asked to sign in.',
        warn: false,
        askOwner: true,
        summary: 'the field is not a password field: the saved password was not typed',
        outcome: null,
      };
    case 'disabled':
      return { text: UNAVAILABLE, warn: false, summary: 'saved logins are switched off in the vault', outcome: 'DISABLED' };
    case 'unauthorized':
      return { text: UNAVAILABLE, warn: false, summary: 'the vault refused the connection', outcome: 'UNAUTHORIZED' };
    case 'unavailable':
    case 'timed_out':
      return { text: UNAVAILABLE, warn: false, summary: 'the vault could not be reached', outcome: code === 'unavailable' ? 'UNAVAILABLE' : null };
    case 'rate_limited':
      return { text: UNAVAILABLE, warn: false, summary: `the vault asked to wait${retryAfterSeconds ? ` ${retryAfterSeconds} s` : ''}`, outcome: 'RATE_LIMITED' };
    case 'not_found':
    case 'no_provider':
    case 'provider_required':
      return { text: UNAVAILABLE, warn: false, summary: 'no saved login is available', outcome: null };
    case 'typing_failed':
      return { text: 'Could not type into that field. Check the selector with observe_elements and call the tool again for that field only; nothing else was typed.', warn: false, summary: 'could not type into the field', outcome: null };
    case 'origin_unavailable':
      return { text: 'The page address could not be read, so nothing was typed. Wait for the page to load and try again once, or ask the owner.', warn: false, summary: 'the page address could not be read', outcome: null };
    case 'cancelled':
      return { text: 'The step was cancelled.', warn: false, summary: 'cancelled', outcome: null };
    default:
      return { text: UNAVAILABLE, warn: false, summary: 'saved logins could not be used', outcome: null };
  }
}

/** The warning card the run asks the owner with after a look-alike or foreign origin (kind `login`, the owner takes over). */
export function mismatchPrompt(pageHost: string | null, loginName: string, savedHost: string | null = null): string {
  // Both addresses, so the owner can tell a look-alike from the real site: the page it is on, and the site the login is saved for.
  const hosts = [pageHost ? `The page is ${pageHost}.` : null, savedHost ? `The login is saved for ${savedHost}.` : null].filter(Boolean).join(' ');
  return `Warning: the agent was about to sign in with your saved login '${loginName.slice(0, 80)}', but this page is not the site that login is saved for.${hosts ? ` ${hosts}` : ''} Nothing was typed and the agent will not try another saved login. If this is the site you meant, sign in yourself and press Done. If it looks like a copy of a site you know, stop the run.`;
}

/** The card the run asks the owner with when the field the model named for a saved password is not a password field (kind `login`, the owner takes over). */
export function notPasswordPrompt(pageHost: string | null, loginName: string): string {
  return `The agent was about to sign in with your saved login '${loginName.slice(0, 80)}'${pageHost ? ` on ${pageHost}` : ''}, but the field it chose for the password is not a password field, so your password was not typed. Please sign in yourself and press Done.`;
}

/** The line the next round's input carries after a mismatch. */
export const MISMATCH_LOG =
  'A saved login was refused on this page: it is not the site that login is saved for. Nothing was typed. Do not try another login, and do not use saved logins again in this run. The owner was asked to look.';

/** What the run does when the site did not accept a typed password: it is never typed twice per run. */
export const PASSWORD_ALREADY_TYPED =
  "That login's password was already typed in this run. If the site did not accept it, do not try it again (repeated failures lock accounts): ask the owner to sign in with request_human, kind \"login\", input \"credentials\".";

/** `<itemId>@<origin>`, the key of the once-per-run rules. */
export const loginKey = (itemId: string, origin: string): string => `${itemId}@${origin}`;
