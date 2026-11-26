// Google's diagnostics (E50.11, #981; closes the API half of #681): which Google API to enable, read from the answer's reason and
// service id only, and the checks of the deployment's app with no user.
//
// Google answers a call to an API that is not enabled in the client's Cloud project with a 403 whose reason is `accessNotConfigured`
// (the v1 error format) or `SERVICE_DISABLED` (the `google.rpc.ErrorInfo` detail, whose `metadata.service` names the API). Only that
// reason and that service id are read, and the id only from the closed list below; the message (which names the project) never is.
// When the id is missing or not on the list, the API is the one the console called (it knows which), never a guess from the text.
import { OutboundHttp } from '../../oauth-client';
import type { StageOutcome } from '../../diagnostics/stages';
import type { DiagnosticStage } from '../../diagnostics/diagnostic-report';
import { groupOf, type Capability } from '../connections.constants';
import { DIAGNOSTIC_CODE, OAUTH_APP_CODES, OAUTH_CONNECTION_CODES, clientCheckOutcome, diagnoseOAuthConnection, redirectOutcome, runAppStages, type CapabilityCheck } from '../oauth-diagnostics';
import type { ConnectionDiagnoseInput, ProviderAppDiagnoseInput } from '../provider';
import { GOOGLE } from './google.constants';
import { GOOGLE_REASONS, readGoogleError } from './google-http';

/** The Google APIs the adapter calls, by service id, with the remedy key that names each as Google Cloud shows it. */
export const GOOGLE_APIS = {
  'gmail.googleapis.com': 'API_DISABLED_GMAIL',
  'calendar-json.googleapis.com': 'API_DISABLED_CALENDAR',
  'drive.googleapis.com': 'API_DISABLED_DRIVE',
  'docs.googleapis.com': 'API_DISABLED_DOCS',
  'sheets.googleapis.com': 'API_DISABLED_SHEETS',
  'people.googleapis.com': 'API_DISABLED_PEOPLE',
} as const;
export type GoogleApi = keyof typeof GOOGLE_APIS;
export const isGoogleApi = (v: unknown): v is GoogleApi => typeof v === 'string' && Object.prototype.hasOwnProperty.call(GOOGLE_APIS, v);

/** The Google discovery document: where the authorization and token endpoints are. */
export const GOOGLE_DISCOVERY = 'https://accounts.google.com/.well-known/openid-configuration';

/** Every code Google's connection stages can return (each has a remedy entry). */
export const GOOGLE_DIAGNOSTIC_CODES: readonly string[] = [...new Set([...OAUTH_CONNECTION_CODES, 'API_DISABLED'])];
/** Every code of Google's app stages. */
export const GOOGLE_APP_DIAGNOSTIC_CODES: readonly string[] = [...new Set([...OAUTH_APP_CODES, 'PICKER_KEY_MISSING'])];

const parse = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};

/**
 * Whether a Google error body says the API is disabled, and which one: the reason codes and `details[].metadata.service` only, and
 * the service only when it is on the closed list.
 */
export function disabledApiOf(body: unknown): { disabled: boolean; api: GoogleApi | null } {
  const { reasons } = readGoogleError(body);
  const disabled = GOOGLE_REASONS.disabled.some((r) => reasons.has(r));
  let api: GoogleApi | null = null;
  const details = (body as { error?: { details?: unknown } } | null)?.error?.details;
  for (const d of Array.isArray(details) ? details : []) {
    const service = (d as { metadata?: { service?: unknown } } | null)?.metadata?.service;
    if (isGoogleApi(service)) {
      api = service;
      break;
    }
  }
  return { disabled, api };
}

/** One Google answer to a capability read as a stage outcome. `api` is the service the console called. */
export function googleOutcome(status: number, body: unknown, api: GoogleApi, opts: { existenceCheck?: boolean } = {}): StageOutcome {
  if (status >= 200 && status < 300) return { status: 'pass' };
  if (status === 401) return { status: 'fail', code: 'UNAUTHORIZED' };
  const { reasons, scopeMessage } = readGoogleError(body);
  const has = (list: readonly string[]) => list.some((r) => reasons.has(r));
  if (status === 403 || status === 429) {
    const off = disabledApiOf(body);
    if (off.disabled) {
      const named = off.api ?? api;
      return { status: 'fail', code: 'API_DISABLED', remedy: GOOGLE_APIS[named], data: { api: named } };
    }
    if (has(GOOGLE_REASONS.quota) && !has(GOOGLE_REASONS.rate)) return { status: 'fail', code: 'QUOTA_EXCEEDED', data: { api } };
    if (has(GOOGLE_REASONS.rate) || status === 429) return { status: 'fail', code: 'RATE_LIMITED', data: { api } };
    if (has(GOOGLE_REASONS.scope) || scopeMessage) return { status: 'fail', code: 'PERMISSION_MISSING', data: { api } };
    // A file the console may not open answers 403 too: for an existence check that means the API is on.
    if (opts.existenceCheck) return { status: 'pass' };
    return { status: 'fail', code: 'FORBIDDEN', data: { api } };
  }
  if (status >= 500) return { status: 'fail', code: 'UNAVAILABLE', data: { api } };
  // A Docs or Sheets read of an id that does not exist: the API answered, so it is enabled.
  if (opts.existenceCheck && (status === 400 || status === 404)) return { status: 'pass' };
  if (status === 404) return { status: 'fail', code: 'NOT_FOUND', data: { api } };
  return { status: 'fail', code: 'FAILED', data: { api } };
}

interface Read {
  api: GoogleApi;
  url: string;
  /** Docs and Sheets have no cheap list call: a read of an id that cannot exist tells an enabled API (404) from a disabled one (403). */
  existenceCheck?: boolean;
}

/** The reads per capability group. Mail, calendar: the same call as `probe`. Documents: Drive's `about`, then Docs and Sheets. */
export function readsOf(capability: Capability): Read[] {
  switch (groupOf(capability)) {
    case 'mail':
      return [{ api: 'gmail.googleapis.com', url: `${GOOGLE.gmail}/labels?fields=labels(id)` }];
    case 'calendar':
      return [{ api: 'calendar-json.googleapis.com', url: `${GOOGLE.calendar}/users/me/calendarList?maxResults=1&fields=items(id)` }];
    default:
      return [
        { api: 'drive.googleapis.com', url: `${GOOGLE.drive}/about?fields=user(kind)` },
        { api: 'docs.googleapis.com', url: `${GOOGLE.docs}/hexactra-diagnostic-check?fields=documentId`, existenceCheck: true },
        { api: 'sheets.googleapis.com', url: `${GOOGLE.sheets}/hexactra-diagnostic-check?fields=spreadsheetId`, existenceCheck: true },
      ];
  }
}

const SHORT: Record<GoogleApi, string> = {
  'gmail.googleapis.com': 'gmail',
  'calendar-json.googleapis.com': 'calendar',
  'drive.googleapis.com': 'drive',
  'docs.googleapis.com': 'docs',
  'sheets.googleapis.com': 'sheets',
  'people.googleapis.com': 'people',
};

/** The cheap reads of one capability: every API it uses is read (one disabled API does not hide another). */
export async function checkGoogleCapability(http: OutboundHttp, capability: Capability, accessToken: string, signal: AbortSignal, clock: () => number = Date.now): Promise<CapabilityCheck> {
  const reads = readsOf(capability);
  let first: StageOutcome | null = null;
  let date: CapabilityCheck['date'] = null;
  const enabled: Record<string, boolean> = {};
  let disabled = 0;
  for (const read of reads) {
    let outcome: StageOutcome;
    try {
      const res = await http.send({ method: 'GET', url: read.url, headers: { authorization: `Bearer ${accessToken}` }, maxBytes: 64 * 1024, timeoutMs: 15_000, signal });
      if (!date && res.headers.date) date = { header: res.headers.date, at: clock() };
      outcome = googleOutcome(res.status, parse(res.body), read.api, { existenceCheck: read.existenceCheck });
    } catch {
      outcome = { status: 'fail', code: 'UNAVAILABLE', data: { api: read.api } };
    }
    const off = outcome.code === 'API_DISABLED';
    if (off) disabled += 1;
    if (reads.length > 1) enabled[SHORT[read.api]] = !off;
    if (outcome.status === 'fail' && !first) first = outcome;
  }
  if (!first) return { outcome: { status: 'pass', ...(reads.length > 1 ? { data: enabled } : {}) }, date };
  return { outcome: { ...first, data: { ...(first.data ?? {}), ...(reads.length > 1 ? { ...enabled, disabled } : {}) } }, date };
}

/** `diagnose` of the Google adapter. */
export function diagnoseGoogleConnection(http: OutboundHttp, input: ConnectionDiagnoseInput, capabilitiesGranted: (scopes: readonly string[]) => Capability[]): Promise<DiagnosticStage[]> {
  const clock = input.clock ?? Date.now;
  return diagnoseOAuthConnection(input, { capabilitiesGranted, check: (c, token, signal) => checkGoogleCapability(http, c, token, signal, clock) });
}

/** `diagnoseApp` of the Google adapter: the redirect address, the discovery document, the client id and secret, the Picker key. */
export function diagnoseGoogleApp(http: OutboundHttp, input: ProviderAppDiagnoseInput): Promise<DiagnosticStage[]> {
  return runAppStages(
    [
      { id: 'redirect_uri', run: () => redirectOutcome(input.app, input.publicOrigin) },
      {
        id: 'discovery',
        run: async (signal): Promise<StageOutcome> => {
          try {
            const res = await http.send({ method: 'GET', url: GOOGLE_DISCOVERY, maxBytes: 64 * 1024, timeoutMs: 10_000, signal });
            const doc = parse(res.body) as { authorization_endpoint?: unknown; token_endpoint?: unknown } | null;
            if (res.status !== 200 || typeof doc?.authorization_endpoint !== 'string' || typeof doc.token_endpoint !== 'string') return { status: 'fail', code: 'UNAVAILABLE', data: { status: res.status } };
            return { status: 'pass', data: { endpoints_match: doc.authorization_endpoint === GOOGLE.authorize && doc.token_endpoint === GOOGLE.token } };
          } catch {
            return { status: 'fail', code: 'UNAVAILABLE' };
          }
        },
      },
      {
        // Google's token endpoint answers a deliberately invalid code with `invalid_grant` when the client id and secret are good, and
        // with `invalid_client` when either is not (RFC 6749 §5.2; Google's OAuth 2.0 web-server documentation). No token is issued.
        id: 'client_check',
        run: async (signal): Promise<StageOutcome> => {
          try {
            const body = new URLSearchParams({ grant_type: 'authorization_code', code: DIAGNOSTIC_CODE, redirect_uri: input.app.redirectUri, client_id: input.app.clientId, client_secret: input.app.clientSecret }).toString();
            const res = await http.send({ method: 'POST', url: GOOGLE.token, headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, maxBytes: 16 * 1024, timeoutMs: 10_000, signal });
            return clientCheckOutcome(res.status, res.body);
          } catch {
            return { status: 'fail', code: 'UNAVAILABLE' };
          }
        },
      },
      // The file picker of Documents needs the browser key; without it the owner can still read and write files by id.
      { id: 'picker_key', run: () => (input.pickerApiKey ? { status: 'pass' } : { status: 'warn', code: 'PICKER_KEY_MISSING' }) },
    ],
    input.signal,
  );
}
