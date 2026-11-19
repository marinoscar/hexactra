// The Google permissions of each capability, exactly as the decision record lists them (docs/decisions/connections-auth.md,
// "Permission sets per capability"; E39.1, #598). Least privilege: only what the switched-on capabilities need.
//
//   mail_read      gmail.readonly                                (restricted)
//   mail_send      gmail.send                                    (sensitive)
//   mail_modify    gmail.modify                                  (restricted; includes read)
//   calendar_read  calendar.readonly                             (sensitive)
//   calendar_write calendar.events (+ calendar.readonly via the read it brings)
//   docs_read      drive.file + documents.readonly + spreadsheets.readonly
//   docs_write     drive.file + documents + spreadsheets
//
// Always asked: openid, email, profile (who the account is).
//
// Where the issue text and the record differ, the record wins: Google documents are read by id (or from files the owner picked or
// the app created) because `drive.file` is the only Drive permission, and `mail_modify` is its own switch.
import { CAPABILITIES, type Capability } from '../connections.constants';

const AUTH = 'https://www.googleapis.com/auth/';

export const GOOGLE_IDENTITY_SCOPES = ['openid', 'email', 'profile'] as const;

export const SCOPE = {
  gmailRead: `${AUTH}gmail.readonly`,
  gmailSend: `${AUTH}gmail.send`,
  gmailModify: `${AUTH}gmail.modify`,
  calendarRead: `${AUTH}calendar.readonly`,
  calendarEvents: `${AUTH}calendar.events`,
  calendar: `${AUTH}calendar`,
  driveFile: `${AUTH}drive.file`,
  documentsRead: `${AUTH}documents.readonly`,
  documents: `${AUTH}documents`,
  sheetsRead: `${AUTH}spreadsheets.readonly`,
  sheets: `${AUTH}spreadsheets`,
} as const;

const SCOPES_OF: Record<Capability, readonly string[]> = {
  mail_read: [SCOPE.gmailRead],
  mail_send: [SCOPE.gmailSend],
  mail_modify: [SCOPE.gmailModify],
  calendar_read: [SCOPE.calendarRead],
  calendar_write: [SCOPE.calendarEvents],
  docs_read: [SCOPE.driveFile, SCOPE.documentsRead, SCOPE.sheetsRead],
  docs_write: [SCOPE.driveFile, SCOPE.documents, SCOPE.sheets],
};

/** A permission that already includes another one: asking for both is redundant (and a read-only one next to its write version is noise on the consent screen). */
const SUBSUMES: Record<string, readonly string[]> = {
  [SCOPE.gmailModify]: [SCOPE.gmailRead],
  [SCOPE.documents]: [SCOPE.documentsRead],
  [SCOPE.sheets]: [SCOPE.sheetsRead],
  [SCOPE.calendar]: [SCOPE.calendarRead, SCOPE.calendarEvents],
};

/** The scopes to ask for the given capabilities, without redundant read-only ones, without the identity scopes. */
export function capabilityScopes(capabilities: readonly Capability[]): string[] {
  const all = new Set(capabilities.flatMap((c) => SCOPES_OF[c]));
  for (const [big, small] of Object.entries(SUBSUMES)) if (all.has(big)) for (const s of small) all.delete(s);
  return [...all];
}

/** `scopesFor` of the adapter: the identity scopes plus the capabilities'. */
export const scopesForCapabilities = (capabilities: readonly Capability[]): string[] => [...GOOGLE_IDENTITY_SCOPES, ...capabilityScopes(capabilities)];

const covers = (granted: ReadonlySet<string>, scope: string): boolean => granted.has(scope) || (SUBSUMES_BY[scope] ?? []).some((big) => granted.has(big));

// For each scope, the bigger scopes that include it.
const SUBSUMES_BY: Record<string, string[]> = {};
for (const [big, small] of Object.entries(SUBSUMES)) for (const s of small) (SUBSUMES_BY[s] ??= []).push(big);

/** What a set of GRANTED scopes allows: a capability is granted only if every scope it needs is (a bigger scope also covers a smaller one). */
export function capabilitiesFromScopes(scopes: readonly string[]): Capability[] {
  const granted = new Set(scopes);
  return CAPABILITIES.filter((c) => SCOPES_OF[c].every((s) => covers(granted, s)));
}
