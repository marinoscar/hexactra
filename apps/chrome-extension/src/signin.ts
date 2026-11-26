// Live Google sign-in check (E48, #928; docs/decisions/profile-signin-health.md).
//
// While the profile's Chrome runs, the service worker asks Google which
// accounts this profile's cookie jar holds, the way Chrome itself does:
// `POST https://accounts.google.com/ListAccounts?...&json=standard`. The
// extension's `<all_urls>` host permission makes the request carry the
// profile's Google cookies and lifts CORS; no new permission is needed. It
// uses no tab, no focus and no debugger, so a run on the profile is not
// disturbed.
//
// Only `{ signin, accounts: [{ provider, email, state }] }` leaves this
// module: never a cookie, a header or Google's response. Any failure
// (network error, timeout, non-200, a body that does not parse) is
// `unknown`, never `signed_out`, with a `reason` from a fixed set
// (`http_<status>`, `timeout`, `network`, `parse`) for the agent's log (#990).

export const LIST_ACCOUNTS_URL = 'https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard';
export const SIGNIN_TIMEOUT_MS = 15_000;
const MAX_ACCOUNTS = 10;
const MAX_EMAIL = 320;

export type SigninState = 'signed_in' | 'signed_out' | 'expired' | 'unknown';

export interface SigninAccount {
  provider: 'google';
  email: string;
  state: 'signed_in' | 'expired';
}

/** Why a check is `unknown`: a fixed set, never text from Google's answer. */
export type SigninUnknownReason = `http_${number}` | 'timeout' | 'network' | 'parse';

export interface SigninResult {
  signin: SigninState;
  accounts: SigninAccount[];
  /** Only with `unknown`. */
  reason?: SigninUnknownReason;
}

/** The native message the agent receives. */
export interface ProfileStatusMessage extends SigninResult {
  type: 'profile_status';
}

function unknown(reason: SigninUnknownReason): SigninResult {
  return { signin: 'unknown', accounts: [], reason };
}
const UNKNOWN: SigninResult = unknown('parse');

function usableEmail(e: unknown): e is string {
  return typeof e === 'string' && e.length > 0 && e.length <= MAX_EMAIL && e.includes('@') && !/[\s\p{Cc}]/u.test(e);
}

/**
 * Classify a `ListAccounts` answer, `["gaia.l.a.r", [account, ...]]`, as
 * Chromium's `ParseListAccountsData` reads it: index 3 the email, 9 `1`
 * when the session is valid (`0`: Google wants the person to sign in
 * again), 14 `1` when the account was signed out but is still listed.
 * Anything that does not have that shape is `unknown`.
 */
export function parseListAccounts(body: string): SigninResult {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return UNKNOWN;
  }
  if (!Array.isArray(data) || data[0] !== 'gaia.l.a.r' || !Array.isArray(data[1])) return UNKNOWN;
  const accounts: SigninAccount[] = [];
  for (const a of data[1] as unknown[]) {
    if (!Array.isArray(a)) return UNKNOWN;
    if (a[14] === 1) continue; // signed out, still listed
    const valid = a[9];
    if (valid !== 0 && valid !== 1) return UNKNOWN;
    if (!usableEmail(a[3])) return UNKNOWN;
    const email = a[3];
    if (accounts.length < MAX_ACCOUNTS && !accounts.some((x) => x.email === email)) {
      accounts.push({ provider: 'google', email, state: valid === 1 ? 'signed_in' : 'expired' });
    }
  }
  const signin: SigninState = accounts.some((a) => a.state === 'signed_in')
    ? 'signed_in'
    : accounts.length > 0
      ? 'expired'
      : 'signed_out';
  return { signin, accounts };
}

/** Ask Google which accounts this profile is signed in to. Never throws. */
export async function checkGoogleSignin(fetchImpl: typeof fetch = fetch, timeoutMs = SIGNIN_TIMEOUT_MS): Promise<SigninResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(LIST_ACCOUNTS_URL, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (resp.status !== 200) return unknown(`http_${Math.trunc(Number(resp.status)) || 0}`);
    return parseListAccounts(await resp.text());
  } catch {
    return unknown(ctrl.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
}

/** The message sent to the agent: copies only the state and the emails. */
export function profileStatusMessage(r: SigninResult): ProfileStatusMessage {
  return {
    type: 'profile_status',
    signin: r.signin,
    accounts: r.accounts.map((a) => ({ provider: 'google', email: a.email, state: a.state })),
    ...(r.signin === 'unknown' && r.reason ? { reason: r.reason } : {}),
  };
}

let inFlight: Promise<void> | null = null;

/**
 * Run the check and hand the result to `post` (the native port). Checks
 * asked for while one runs share it.
 */
export function reportSignin(post: (m: ProfileStatusMessage) => void, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const r = await checkGoogleSignin(fetchImpl);
      try {
        post(profileStatusMessage(r));
      } catch {
        // The port closed meanwhile; the next connection checks again.
      }
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** A page on accounts.google.com finished loading (a sign-in or sign-out). */
export function isGoogleAccountsUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'accounts.google.com';
  } catch {
    return false;
  }
}
