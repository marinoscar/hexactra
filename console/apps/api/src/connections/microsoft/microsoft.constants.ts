// The facts about Microsoft's identity platform and Graph that the Microsoft provider (E39.4, #602) relies on. PROVISIONAL like the
// decision record they come from (docs/decisions/connections-auth.md): derived from documentation, not yet tried on a real account.
import type { Capability } from '../connections.constants';

export const LOGIN_BASE = 'https://login.microsoftonline.com';
export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
export const GRAPH_SCOPE_PREFIX = 'https://graph.microsoft.com/';

/** The tenant id every personal Microsoft account (Outlook.com, Hotmail, Live) signs in under. */
export const CONSUMER_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad';

/** Always requested: the identity, a refresh token and the account's own profile. */
export const BASE_SCOPES = ['openid', 'email', 'profile', 'offline_access', 'User.Read'] as const;

/** The delegated permission each capability needs, from the decision record ("Permission sets per capability"). */
export const SCOPE_OF: Record<Capability, string> = {
  mail_read: 'Mail.Read',
  mail_send: 'Mail.Send',
  mail_modify: 'Mail.ReadWrite',
  calendar_read: 'Calendars.Read',
  calendar_write: 'Calendars.ReadWrite',
  docs_read: 'Files.Read',
  docs_write: 'Files.ReadWrite',
};

/** A permission that includes a smaller one (Graph `*.ReadWrite` includes `*.Read`; `Mail.ReadWrite` does NOT include `Mail.Send`). */
export const IMPLIED_BY: Record<string, readonly string[]> = {
  'Mail.Read': ['Mail.ReadWrite'],
  'Calendars.Read': ['Calendars.ReadWrite'],
  'Files.Read': ['Files.ReadWrite', 'Files.Read.All', 'Files.ReadWrite.All'],
  'Files.ReadWrite': ['Files.ReadWrite.All'],
};

/** Time zone every response is asked in (`Prefer: outlook.timezone`): instants come back as UTC and are written with an offset. */
export const RESPONSE_TIME_ZONE = 'UTC';

/** What a single Graph request may carry inline: a file under this size is a simple upload or an inline attachment. */
export const SIMPLE_UPLOAD_BYTES = 4 * 1024 * 1024;
export const INLINE_ATTACHMENT_BYTES = 3 * 1024 * 1024;
/** Upload sessions take chunks that are a multiple of 320 KiB. */
export const UPLOAD_CHUNK_BYTES = 320 * 1024 * 10;

export const MAIL_FIELDS = 'id,conversationId,from,toRecipients,subject,bodyPreview,receivedDateTime,isRead,hasAttachments,categories,parentFolderId,isDraft';
export const MESSAGE_FIELDS = `${MAIL_FIELDS},ccRecipients,replyTo,internetMessageId,body,uniqueBody`;

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** `<tenant id>:<object id>`, lower case: the stable id stored as `accountId` (docs/connections.md, "Microsoft"). */
export const microsoftAccountId = (tenantId: string, objectId: string): string => `${tenantId.toLowerCase()}:${objectId.toLowerCase()}`;
export type MicrosoftAccountKind = 'personal' | 'work';
/** Personal accounts sit in the fixed consumer tenant; anything else (or an id this code cannot read) is treated as a work or school account. */
export function microsoftAccountKind(accountId: string | undefined): MicrosoftAccountKind {
  return accountId?.split(':')[0]?.toLowerCase() === CONSUMER_TENANT_ID ? 'personal' : 'work';
}

/** The authority segment for a tenant setting: `common`, `organizations`, `consumers` or a tenant id. */
export function authorityOf(tenant: string | null | undefined): string {
  const t = (tenant ?? '').trim();
  return /^[A-Za-z0-9.-]{1,100}$/.test(t) ? t : 'common';
}
