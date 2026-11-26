// Microsoft's diagnostics (E50.11, #981): Graph's error `code` field (never its message) mapped to a closed list, and the checks of
// the deployment's app registration with no user. PROVISIONAL like microsoft.constants.ts: the Graph and identity-platform codes
// below are from Microsoft's documentation (Graph error responses, the Outlook and OneDrive error codes, the AADSTS list), not yet
// seen on a real account (#661).
import type { StageOutcome } from '../../diagnostics/stages';
import type { DiagnosticStage } from '../../diagnostics/diagnostic-report';
import { groupOf, type Capability } from '../connections.constants';
import { DIAGNOSTIC_CODE, OAUTH_APP_CODES, OAUTH_CONNECTION_CODES, clientCheckOutcome, diagnoseOAuthConnection, redirectOutcome, runAppStages, type CapabilityCheck } from '../oauth-diagnostics';
import type { ConnectionDiagnoseInput, ProviderAppDiagnoseInput } from '../provider';
import { GRAPH_BASE, LOGIN_BASE, authorityOf } from './microsoft.constants';

/** The account has no Exchange Online mailbox (a OneDrive-only or on-premises account, an inactive or soft-deleted mailbox). */
export const GRAPH_MAILBOX_CODES = ['MailboxNotEnabledForRESTAPI', 'MailboxNotSupportedForRESTAPI', 'ErrorNonExistentMailbox', 'MailboxNotFound', 'ErrorMailboxNotFound'];
/** The account has no licence for the service (Exchange Online, OneDrive / SharePoint). */
export const GRAPH_LICENSE_CODES = ['ErrorInvalidLicense', 'LicenseNotFound', 'ErrorLicenseNotAssigned', 'TenantDoesNotHaveSPOLicense'];
/** The token lacks the delegated permission. */
export const GRAPH_PERMISSION_CODES = ['ErrorAccessDenied', 'Authorization_RequestDenied', 'accessDenied', 'AccessDenied', 'ErrorInsufficientPermissions'];
/** An administrator of the account's organization has to approve the app. */
export const GRAPH_ADMIN_CONSENT_CODES = ['AdminConsentRequired', 'consent_required'];
const QUOTA_CODES = ['quotaLimitReached', 'ErrorQuotaExceeded', 'insufficientStorage'];

/** The identity platform's code for a tenant that does not exist (`AADSTS90002`). */
export const TENANT_NOT_FOUND_CODES = [90002];
/** The identity platform's codes for a client the platform refuses: a wrong or expired secret, an unknown application id. */
export const CLIENT_REFUSED_CODES = [7000215, 7000222, 700016, 7000216];

/** Every code Microsoft's connection stages can return. */
export const MICROSOFT_DIAGNOSTIC_CODES: readonly string[] = [...new Set([...OAUTH_CONNECTION_CODES, 'MAILBOX_NOT_FOUND', 'LICENSE_MISSING', 'ADMIN_CONSENT_REQUIRED'])];
/** Every code of Microsoft's app stages. */
export const MICROSOFT_APP_DIAGNOSTIC_CODES: readonly string[] = [...new Set([...OAUTH_APP_CODES, 'TENANT_NOT_FOUND'])];

/** One Graph answer to a capability read: the status and the error's `code` field only. */
export function graphOutcome(status: number, code: string, capability: Capability): StageOutcome {
  if (status >= 200 && status < 300) return { status: 'pass' };
  if (GRAPH_MAILBOX_CODES.includes(code) || (groupOf(capability) === 'mail' && status === 404 && (code === 'ResourceNotFound' || /mailbox/i.test(code)))) return { status: 'fail', code: 'MAILBOX_NOT_FOUND' };
  if (GRAPH_LICENSE_CODES.includes(code)) return { status: 'fail', code: 'LICENSE_MISSING' };
  if (GRAPH_ADMIN_CONSENT_CODES.includes(code)) return { status: 'fail', code: 'ADMIN_CONSENT_REQUIRED' };
  if (status === 401) return { status: 'fail', code: 'UNAUTHORIZED' };
  if (QUOTA_CODES.includes(code) || status === 507) return { status: 'fail', code: 'QUOTA_EXCEEDED' };
  if (status === 403) return { status: 'fail', code: GRAPH_PERMISSION_CODES.includes(code) ? 'PERMISSION_MISSING' : 'FORBIDDEN' };
  if (status === 429) return { status: 'fail', code: 'RATE_LIMITED' };
  if (status >= 500) return { status: 'fail', code: 'UNAVAILABLE' };
  if (status === 404) return { status: 'fail', code: 'NOT_FOUND' };
  return { status: 'fail', code: 'FAILED' };
}

/** The same read per capability as `probe`. */
export function graphPathOf(capability: Capability): string {
  const group = groupOf(capability);
  return group === 'calendar' ? '/me/calendars?$top=1&$select=id' : group === 'docs' ? '/me/drive?$select=id' : '/me/mailFolders/inbox?$select=id';
}

const errorCodeOf = async (res: Response): Promise<string> =>
  res
    .json()
    .then((j: { error?: { code?: unknown } }) => (typeof j?.error?.code === 'string' ? j.error.code : ''))
    .catch(() => '');

export async function checkGraphCapability(doFetch: typeof fetch, capability: Capability, accessToken: string, signal: AbortSignal, clock: () => number = Date.now): Promise<CapabilityCheck> {
  let res: Response;
  try {
    res = await doFetch(`${GRAPH_BASE}${graphPathOf(capability)}`, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), redirect: 'manual' });
  } catch {
    return { outcome: { status: 'fail', code: 'UNAVAILABLE' } };
  }
  const header = res.headers.get('date');
  const date = header ? { header, at: clock() } : null;
  const code = res.status >= 200 && res.status < 300 ? '' : await errorCodeOf(res);
  return { outcome: graphOutcome(res.status, code, capability), date };
}

export function diagnoseMicrosoftConnection(doFetch: typeof fetch, input: ConnectionDiagnoseInput, capabilitiesGranted: (scopes: readonly string[]) => Capability[]): Promise<DiagnosticStage[]> {
  const clock = input.clock ?? Date.now;
  return diagnoseOAuthConnection(input, { capabilitiesGranted, check: (c, token, signal) => checkGraphCapability(doFetch, c, token, signal, clock) });
}

/** The `error_codes` of an identity-platform answer (numbers only). */
function errorCodesOf(body: string): number[] {
  try {
    const doc = JSON.parse(body) as { error_codes?: unknown };
    return Array.isArray(doc?.error_codes) ? doc.error_codes.filter((c): c is number => typeof c === 'number') : [];
  } catch {
    return [];
  }
}

/** `diagnoseApp` of the Microsoft adapter: the redirect address, the tenant's discovery document, the client id and secret. */
export function diagnoseMicrosoftApp(doFetch: typeof fetch, input: ProviderAppDiagnoseInput): Promise<DiagnosticStage[]> {
  const authority = authorityOf(input.app.tenant);
  const fetchText = async (url: string, init: RequestInit, signal: AbortSignal): Promise<{ status: number; body: string }> => {
    const res = await doFetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), redirect: 'manual' });
    return { status: res.status, body: await res.text().catch(() => '') };
  };
  return runAppStages(
    [
      { id: 'redirect_uri', run: () => redirectOutcome(input.app, input.publicOrigin) },
      {
        // The tenant's OpenID configuration: an unknown tenant is AADSTS90002.
        id: 'discovery',
        run: async (signal): Promise<StageOutcome> => {
          try {
            const res = await fetchText(`${LOGIN_BASE}/${authority}/v2.0/.well-known/openid-configuration`, { headers: { accept: 'application/json' } }, signal);
            if (errorCodesOf(res.body).some((c) => TENANT_NOT_FOUND_CODES.includes(c))) return { status: 'fail', code: 'TENANT_NOT_FOUND' };
            let doc: { authorization_endpoint?: unknown; token_endpoint?: unknown } | null = null;
            try {
              doc = JSON.parse(res.body);
            } catch {
              doc = null;
            }
            if (res.status !== 200 || typeof doc?.authorization_endpoint !== 'string' || typeof doc.token_endpoint !== 'string') return { status: 'fail', code: 'UNAVAILABLE', data: { status: res.status } };
            return { status: 'pass', data: { tenant_kind: ['common', 'organizations', 'consumers'].includes(authority) ? authority : 'tenant_id' } };
          } catch {
            return { status: 'fail', code: 'UNAVAILABLE' };
          }
        },
      },
      {
        // A token request with a deliberately invalid code: `invalid_grant` (AADSTS70000, 9002313, 54005) when the client id and secret
        // are good; `invalid_client` (AADSTS7000215 wrong secret, 7000222 expired) or `unauthorized_client` (AADSTS700016 unknown app)
        // when not. Nothing is issued. Anything else cannot be told apart without a sign-in.
        id: 'client_check',
        run: async (signal): Promise<StageOutcome> => {
          try {
            const body = new URLSearchParams({
              client_id: input.app.clientId,
              client_secret: input.app.clientSecret,
              grant_type: 'authorization_code',
              code: DIAGNOSTIC_CODE,
              redirect_uri: input.app.redirectUri,
              code_verifier: 'hexactra-diagnostic-verifier-that-matches-no-challenge-0000',
            }).toString();
            const res = await fetchText(`${LOGIN_BASE}/${authority}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body }, signal);
            const codes = errorCodesOf(res.body);
            if (codes.some((c) => TENANT_NOT_FOUND_CODES.includes(c))) return { status: 'fail', code: 'TENANT_NOT_FOUND' };
            if (codes.some((c) => CLIENT_REFUSED_CODES.includes(c))) return { status: 'fail', code: 'APP_CREDENTIALS_REFUSED', data: { status: res.status } };
            return clientCheckOutcome(res.status, res.body);
          } catch {
            return { status: 'fail', code: 'UNAVAILABLE' };
          }
        },
      },
    ],
    input.signal,
  );
}
