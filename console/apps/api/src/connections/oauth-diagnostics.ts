// The stages Google and Microsoft share (E50.11, #981): one report reads the same for both providers.
//
//   For a connection:             app_config, sign_in, token_lifetime, permissions, capability:<name> (one each, independent), clock
//   For the deployment's app:     redirect_uri, discovery, client_check (+ the provider's own, such as Google's picker_key);
//                                 the `app_config` stage before them is the console's (connection-app-diagnostics.service.ts).
//
// Each provider supplies what only it knows: which capabilities its granted scopes cover and the one cheap read per capability (the
// call `probe` makes for `POST /test`). Read calls only. A stage carries codes from a closed list, counts, booleans, a host name or an
// API id: never a provider's message, an account address, a subject, a file name or a token (`sanitizeStages` checks again).
import { runStages, type StageOutcome, type StageStep } from '../diagnostics/stages';
import type { DiagnosticStage, StageData } from '../diagnostics/diagnostic-report';
import type { Capability } from './connections.constants';
import { ConnectionError } from './connections.errors';
import type { ConnectionDiagnoseInput, ProviderApp } from './provider';

/** One stage's deadline inside a provider's report. */
export const PROVIDER_STAGE_DEADLINE_MS = 8_000;
/**
 * The health job (`connections.health`) runs once a day and refreshes a connection nothing used for 20 hours: a last refresh older
 * than that plus a day means it should have run and did not renew this one.
 */
export const REFRESH_STALE_AFTER_MS = (20 + 24) * 60 * 60_000; // IDLE_AFTER_MS of connections.jobs.ts plus a day (not imported: no cycle)
/** Token validation tolerates a few minutes of skew; over two minutes is worth fixing (NTP) before it fails. */
export const CLOCK_SKEW_WARN_MS = 2 * 60_000;
/** The code presented by `client_check`: invalid on purpose, so a valid app is answered `invalid_grant` and nothing is issued. */
export const DIAGNOSTIC_CODE = 'hexactra-diagnostic-invalid-code';

/** What `sign_in` can say: the reconnect reasons, the app refused, and the provider out of reach. */
export const SIGN_IN_CODES = ['GRANT_REVOKED', 'NO_REFRESH_TOKEN', 'TOKEN_STORE_FAILED', 'CONNECTION_NEEDS_RECONNECT', 'CONNECTION_PAUSED', 'APP_CREDENTIALS_REFUSED', 'ADMIN_CONSENT_REQUIRED', 'APP_NOT_CONFIGURED', 'NOT_INSTALLED', 'UNAVAILABLE', 'TIMEOUT'] as const;
/** What a capability read can say, for either provider. */
export const CAPABILITY_CODES = ['UNAUTHORIZED', 'FORBIDDEN', 'PERMISSION_MISSING', 'RATE_LIMITED', 'QUOTA_EXCEEDED', 'UNAVAILABLE', 'NOT_FOUND', 'FAILED'] as const;
/** Every code of a connection's shared stages (each has a remedy entry: test/diagnostics.spec.ts). */
export const OAUTH_CONNECTION_CODES: readonly string[] = [
  ...new Set(['PROVIDER_OFF', 'APP_NOT_CONFIGURED', ...SIGN_IN_CODES, 'REFRESH_STALE', 'PERMISSION_MISSING', ...CAPABILITY_CODES, 'CLOCK_SKEW', 'TIMEOUT', 'ABORTED', 'DEADLINE_EXCEEDED']),
];
/** Every code of the shared stages of the deployment's app. */
export const OAUTH_APP_CODES: readonly string[] = ['REDIRECT_NOT_HTTPS', 'APP_URL_MISMATCH', 'UNAVAILABLE', 'APP_CREDENTIALS_REFUSED', 'NEEDS_A_SIGN_IN', 'TIMEOUT', 'ABORTED', 'DEADLINE_EXCEEDED'];

/** The answer of one capability read, and the provider's `Date` header with the server's time when it arrived (for `clock`). */
export interface CapabilityCheck {
  outcome: StageOutcome;
  date?: { header: string; at: number } | null;
}

export interface OAuthDiagnosticProvider {
  /** Which capabilities a set of granted scopes covers (the adapter's `capabilitiesGranted`). */
  capabilitiesGranted(scopes: readonly string[]): Capability[];
  /** One cheap read for a capability. Never throws for a provider answer. */
  check(capability: Capability, accessToken: string, signal: AbortSignal): Promise<CapabilityCheck>;
}

/** A thrown sign-in failure (`ConnectionTokensService.getAccessToken`) as a closed code. Never the error's message. */
export function signInOutcome(e: unknown): StageOutcome {
  if (!(e instanceof ConnectionError)) return { status: 'fail', code: 'UNAVAILABLE' };
  const reason = typeof e.details?.reason === 'string' ? e.details.reason : '';
  switch (e.code) {
    case 'CONNECTION_NEEDS_RECONNECT': {
      const known = ['GRANT_REVOKED', 'NO_REFRESH_TOKEN', 'TOKEN_STORE_FAILED'];
      return { status: 'fail', code: known.includes(reason.toUpperCase()) ? reason.toUpperCase() : 'CONNECTION_NEEDS_RECONNECT' };
    }
    case 'CONNECTION_PAUSED':
      return { status: 'fail', code: 'CONNECTION_PAUSED' };
    case 'CONNECTION_PROVIDER_UNAVAILABLE':
      return { status: 'fail', code: reason === 'not_configured' ? 'APP_NOT_CONFIGURED' : 'NOT_INSTALLED' };
    case 'CONNECTION_UNAVAILABLE': {
      // The token service's reasons (connection-tokens.service.ts, `refreshFailed`), lower case.
      const mapped: Record<string, string> = {
        app_refused: 'APP_CREDENTIALS_REFUSED',
        invalid_client: 'APP_CREDENTIALS_REFUSED',
        unauthorized_client: 'APP_CREDENTIALS_REFUSED',
        admin_consent_required: 'ADMIN_CONSENT_REQUIRED',
        not_configured: 'APP_NOT_CONFIGURED',
        not_installed: 'NOT_INSTALLED',
        refresh_wait_timeout: 'TIMEOUT',
        token_store_failed: 'TOKEN_STORE_FAILED',
      };
      return { status: 'fail', code: mapped[reason] ?? 'UNAVAILABLE' };
    }
    default:
      return { status: 'fail', code: 'UNAVAILABLE' };
  }
}

function appConfigOutcome(input: ConnectionDiagnoseInput): StageOutcome {
  if (input.app === null) return { status: 'fail', code: 'APP_NOT_CONFIGURED' };
  if (input.providerEnabled === false) return { status: 'warn', code: 'PROVIDER_OFF' };
  return { status: 'pass' };
}

const seconds = (ms: number): number => Math.round(ms / 1000);

/** When the access token expires and when it was last refreshed, from the row as the report found it. */
export function tokenLifetimeOutcome(token: ConnectionDiagnoseInput['token'], now: number): StageOutcome {
  if (!token) return { status: 'skipped' };
  const data: StageData = {};
  if (token.expiresAt) data.expires_in_s = seconds(token.expiresAt.getTime() - now);
  const since = token.lastRefreshAt ?? token.createdAt;
  const age = now - since.getTime();
  data[token.lastRefreshAt ? 'last_refresh_age_s' : 'connected_age_s'] = seconds(age);
  return age > REFRESH_STALE_AFTER_MS ? { status: 'warn', code: 'REFRESH_STALE', data } : { status: 'pass', data };
}

/** Each capability that is on against the scopes the provider granted. */
export function permissionsOutcome(capabilities: readonly Capability[], granted: readonly Capability[]): StageOutcome {
  const missing = capabilities.filter((c) => !granted.includes(c));
  if (missing.length === 0) return { status: 'pass', data: { checked: capabilities.length } };
  return { status: 'fail', code: 'PERMISSION_MISSING', data: { capability: missing[0]!, missing: missing.length, checked: capabilities.length } };
}

/** The provider's `Date` header against the server's clock. */
export function clockOutcome(dates: readonly { header: string; at: number }[]): StageOutcome {
  for (const d of dates) {
    const t = Date.parse(d.header);
    if (!Number.isFinite(t)) continue;
    const skew = t - d.at;
    // An HTTP date has whole seconds: a second either way is the header's rounding, not the clock.
    const data = { skew_s: seconds(skew) };
    return Math.abs(skew) > CLOCK_SKEW_WARN_MS ? { status: 'warn', code: 'CLOCK_SKEW', data } : { status: 'pass', data };
  }
  return { status: 'skipped' };
}

const runOptions = (signal: AbortSignal) => ({ signal, stageTimeoutMs: PROVIDER_STAGE_DEADLINE_MS, abortCode: () => (signal.aborted ? 'DEADLINE_EXCEEDED' : 'ABORTED'), errorCode: () => 'UNAVAILABLE' });

/** The stages of one Google or Microsoft connection, in order. Never throws for a provider answer. */
export function diagnoseOAuthConnection(input: ConnectionDiagnoseInput, provider: OAuthDiagnosticProvider): Promise<DiagnosticStage[]> {
  const now = input.clock ?? Date.now;
  const dates: { header: string; at: number }[] = [];
  let token = '';
  const steps: StageStep[] = [
    { id: 'app_config', run: () => appConfigOutcome(input) },
    {
      id: 'sign_in',
      run: async () => {
        try {
          token = await input.accessToken();
          return { status: 'pass' };
        } catch (e) {
          return signInOutcome(e);
        }
      },
    },
    // Read from the row, not from the provider: they say something even when the sign-in failed.
    { id: 'token_lifetime', independent: true, run: () => tokenLifetimeOutcome(input.token, now()) },
    { id: 'permissions', independent: true, run: () => permissionsOutcome(input.capabilities, provider.capabilitiesGranted(input.grantedScopes)) },
    // One read per capability, each on its own: one failing hides none of the others.
    ...input.capabilities.map(
      (capability): StageStep => ({
        id: `capability:${capability}`,
        independent: true,
        dependsOn: ['sign_in'],
        run: async (signal) => {
          const r = await provider.check(capability, token, signal);
          if (r.date) dates.push(r.date);
          return r.outcome;
        },
      }),
    ),
    { id: 'clock', independent: true, run: () => clockOutcome(dates) },
  ];
  return runStages(steps, runOptions(input.signal));
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A host name for a stage (`console.example.test`, `localhost:3535`): what `data` accepts, or null. */
const hostOf = (u: URL): string | null => (/^[A-Za-z0-9][A-Za-z0-9.:-]{0,199}$/.test(u.host) ? u.host : null);

/**
 * `redirect_uri`: the address the console sends (`<APP_URL>/api/connections/callback/<provider>`) is https, and its origin is the one
 * the administrator reached the console on. The stage holds the host names; the full address is on the administrator's page.
 */
export function redirectOutcome(app: ProviderApp, publicOrigin: string | null | undefined): StageOutcome {
  let u: URL;
  try {
    u = new URL(app.redirectUri);
  } catch {
    return { status: 'fail', code: 'REDIRECT_NOT_HTTPS' };
  }
  const https = u.protocol === 'https:';
  const data: StageData = { https };
  const host = hostOf(u);
  if (host) data.redirect_host = host;
  if (!https && !LOOPBACK.has(u.hostname)) return { status: 'fail', code: 'REDIRECT_NOT_HTTPS', data };
  let mismatch = false;
  if (publicOrigin) {
    try {
      const p = new URL(publicOrigin);
      const publicHost = hostOf(p);
      if (publicHost) data.public_host = publicHost;
      mismatch = p.origin !== u.origin;
    } catch {
      // An origin that does not parse says nothing about the console's address.
    }
  }
  data.matches_public = !mismatch;
  if (mismatch) return { status: 'warn', code: 'APP_URL_MISMATCH', data };
  // http on the loopback address works for a developer's own machine only.
  if (!https) return { status: 'warn', code: 'REDIRECT_NOT_HTTPS', data };
  return { status: 'pass', data };
}

/**
 * `client_check` from the token endpoint's answer to a deliberately invalid code (RFC 6749 §5.2): `invalid_client` (or
 * `unauthorized_client`) means the client id or secret is refused; `invalid_grant` means the client was accepted and only the code
 * was wrong. Anything else cannot be told apart without a sign-in. Reads the `error` field only, never the description.
 */
export function clientCheckOutcome(status: number, body: string): StageOutcome {
  let error = '';
  try {
    const doc = JSON.parse(body) as { error?: unknown };
    if (typeof doc?.error === 'string') error = doc.error;
  } catch {
    error = '';
  }
  if (error === 'invalid_client' || error === 'unauthorized_client') return { status: 'fail', code: 'APP_CREDENTIALS_REFUSED', data: { status } };
  if (error === 'invalid_grant') return { status: 'pass', data: { accepted: true } };
  if (status >= 500 || status === 429) return { status: 'fail', code: 'UNAVAILABLE', data: { status } };
  return { status: 'skipped', code: 'NEEDS_A_SIGN_IN', data: { status } };
}

/** Runs a provider's app stages: each independent (one failing hides none of the others), each with its own deadline. */
export function runAppStages(steps: readonly StageStep[], signal: AbortSignal): Promise<DiagnosticStage[]> {
  return runStages(
    steps.map((s) => ({ ...s, independent: true })),
    runOptions(signal),
  );
}

/** The end of a client id an administrator can compare with the provider's console: its last four characters, never more. */
export function clientIdEnd(clientId: string): string | null {
  const id = clientId.replace(/\.apps\.googleusercontent\.com$/i, '');
  const end = id.slice(-4);
  return /^[A-Za-z0-9]{4}$/.test(end) ? end : null;
}
