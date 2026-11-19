// The provider-neutral capability interfaces of Connections (E39.3, #601): what the deliveries (E39.6), the agent tools (E39.7)
// and the mail trigger (E39.8) call. Nothing in those issues talks to Google or Microsoft directly: they ask
// `ConnectionCapabilities` (connection-capabilities.service.ts) for `mail(ctx)`, `calendar(ctx)` or `documents(ctx)` and call the
// methods below. The Google adapter (connections/google/) and the Microsoft one (E39.4) implement them.
//
// Rules this file carries, so that callers and adapters cannot get them wrong:
//   * No provider-specific type leaks out: every input and output is a plain object described by a zod schema here.
//   * Every method is tagged `read` or `write` and with the capability it needs (METHODS below). A call whose connection lacks
//     the capability fails with CAPABILITY_OFF before any network request; a capability the provider did not grant fails with
//     PERMISSION_MISSING (the switch is on but the consent was not given: offer an incremental consent).
//   * The limits live here (CapabilityLimits), not in callers: message text 50,000 characters, an attachment 10 MB, a sheet read
//     5,000 cells, a list page 50. Text that exceeds a limit is cut and marked `truncated`.
//   * Typed errors (CapabilityError) carry a code, a static message and a few safe fields, never text from a provider, because
//     a provider message can carry content (a subject, an address, a file name).
//   * Schemas have no transforms and no defaults: what a caller passes is what an adapter receives, and an omitted field means
//     "use the documented default", resolved by the adapter (`pageSizeOf`, `notifyAttendeesOf`).
import { z } from 'zod';

import { isCapability, type Capability, type ConnectionProviderId } from './connections.constants';

// ---------------------------------------------------------------------------------------------------------------------------
// Context and limits

/** Who is calling and for which account. The token never appears here: the adapter takes it from the token service. */
export interface ConnectionContext {
  connectionId: string;
  userId: string;
  /** Cancels the call (Stop, #582): in-flight requests are aborted and the call fails with `ABORTED`. */
  signal?: AbortSignal;
}

export interface CapabilityLimits {
  /** Message or document text, in characters. */
  bodyChars: number;
  /** One attachment or uploaded file, in bytes. */
  attachmentBytes: number;
  /** All the attachments of one outgoing message, in bytes (Gmail allows 25 MB encoded: about 18 MB raw). */
  outgoingMailBytes: number;
  /** Cells returned by a sheet read, or written by one append. */
  sheetCells: number;
}

export const DEFAULT_CAPABILITY_LIMITS: Readonly<CapabilityLimits> = Object.freeze({
  bodyChars: 50_000,
  attachmentBytes: 10 * 1024 * 1024,
  outgoingMailBytes: 18 * 1024 * 1024,
  sheetCells: 5_000,
});

/** A list page is never larger than this, whatever the caller asks. */
export const MAX_PAGE_SIZE = 50;
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_RECIPIENTS = 100;
export const MAX_ATTENDEES = 100;

export const resolveLimits = (over?: Partial<CapabilityLimits>): CapabilityLimits => ({ ...DEFAULT_CAPABILITY_LIMITS, ...(over ?? {}) });
export const pageSizeOf = (q: { pageSize?: number }): number => Math.min(MAX_PAGE_SIZE, Math.max(1, q.pageSize ?? DEFAULT_PAGE_SIZE));
/** Calendar writes never email people by side effect: the default is no notification. */
export const notifyAttendeesOf = (o: { notifyAttendees?: boolean }): boolean => o.notifyAttendees === true;

// ---------------------------------------------------------------------------------------------------------------------------
// Typed errors

export const CAPABILITY_ERROR_CODES = [
  'CONNECTION_NEEDS_RECONNECT',
  'CAPABILITY_OFF',
  'PERMISSION_MISSING',
  'NOT_FOUND',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'TOO_LARGE',
  'PROVIDER_ERROR',
  // Additions beyond the issue's eight, each needed to be honest about a failure the eight would blur:
  'CONNECTION_PAUSED', // the owner paused the account
  'CONNECTION_NOT_FOUND', // no such connection for this user (also another user's)
  'INVALID_INPUT', // the arguments do not satisfy the schema (details.issues lists the paths, never the values)
  'NOT_SUPPORTED', // this provider has no adapter, or the adapter does not offer the operation
  'ABORTED', // the caller's AbortSignal fired
  // Additions of the Microsoft provider (E39.4, #602), additive: Google never raises them.
  'CONFLICT', // the item changed since it was read (an eTag precondition failed): read it again and retry
  'NOTIFY_REQUIRED', // the change would email attendees and the caller did not allow it (Graph has no "do not notify")
  'ADMIN_CONSENT_REQUIRED', // an administrator of the account's organization has to approve the app (details.adminConsentUrl)
] as const;
export type CapabilityErrorCode = (typeof CAPABILITY_ERROR_CODES)[number];

/** Fixed texts. A provider's own message is never copied: it can carry the very content the owner trusted us with. */
export const CAPABILITY_ERROR_TEXT: Record<CapabilityErrorCode, string> = {
  CONNECTION_NEEDS_RECONNECT: 'The account must be connected again.',
  CAPABILITY_OFF: 'This is not switched on for the account.',
  PERMISSION_MISSING: 'The provider did not grant the permission this needs.',
  NOT_FOUND: 'The item was not found.',
  RATE_LIMITED: 'The provider asked to slow down.',
  QUOTA_EXCEEDED: 'The provider quota is used up.',
  TOO_LARGE: 'The item is larger than the limit.',
  PROVIDER_ERROR: 'The provider could not do it.',
  CONNECTION_PAUSED: 'The account is paused.',
  CONNECTION_NOT_FOUND: 'The account was not found.',
  INVALID_INPUT: 'The request is not valid.',
  NOT_SUPPORTED: 'The provider does not support this.',
  ABORTED: 'The call was cancelled.',
  CONFLICT: 'The item changed in the meantime.',
  NOTIFY_REQUIRED: 'This change would email the attendees, and notifying them was not allowed.',
  ADMIN_CONSENT_REQUIRED: 'An administrator of the account\'s organization has to approve this app first.',
};

export interface CapabilityErrorDetails {
  /** RATE_LIMITED: how long to wait, from the provider's Retry-After or the backoff. */
  retryAfterMs?: number;
  /** PROVIDER_ERROR: the HTTP status the provider answered (0 when it could not be reached). */
  status?: number;
  /** CAPABILITY_OFF, PERMISSION_MISSING: the capability concerned. */
  capability?: Capability;
  /** CONNECTION_*: the connection's label. */
  label?: string;
  /** A stable reason code (`GRANT_REVOKED`, `SCOPE`, `LIMIT_BYTES`), never a message. */
  reason?: string;
  /**
   * A write whose request was sent and got no definite answer (a timeout, a reset, a 5xx) where the provider has no idempotency
   * key: the change may or may not have happened. It was not retried, and a caller retrying could duplicate it.
   */
  outcomeUnknown?: boolean;
  /** INVALID_INPUT: the paths of the offending fields. */
  issues?: string[];
  /** ADMIN_CONSENT_REQUIRED: the address an administrator opens to approve the app for the organization (carries the app's client id, no personal data). */
  adminConsentUrl?: string;
}

/**
 * The one failure type of every capability call. Callers read `.code` and turn it into a question to the owner, a failed
 * delivery or a tool result; `.details` holds only closed, data-free fields.
 */
export class CapabilityError extends Error {
  constructor(
    readonly code: CapabilityErrorCode,
    readonly details: CapabilityErrorDetails = {},
  ) {
    super(CAPABILITY_ERROR_TEXT[code]);
    this.name = 'CapabilityError';
  }

  get retryAfterMs(): number | undefined {
    return this.details.retryAfterMs;
  }

  get status(): number | undefined {
    return this.details.status;
  }

  /** `true` for a failure a retry could cure (rate limit, provider 5xx or unreachable) and cannot duplicate (not `outcomeUnknown`). */
  get retryable(): boolean {
    if (this.details.outcomeUnknown) return false;
    return this.code === 'RATE_LIMITED' || (this.code === 'PROVIDER_ERROR' && (this.details.status === 0 || (this.details.status ?? 0) >= 500));
  }

  toJSON(): { code: CapabilityErrorCode; message: string } & CapabilityErrorDetails {
    return { code: this.code, message: this.message, ...this.details };
  }
}

export const isCapabilityError = (e: unknown): e is CapabilityError => e instanceof CapabilityError;

// ---------------------------------------------------------------------------------------------------------------------------
// Building blocks

// A header value must never carry a line break or another control character (header injection). Tab is allowed.
// eslint-disable-next-line no-control-regex
const HEADER_UNSAFE = /[\u0000-\u0008\u000a-\u001f\u007f\u0085\u2028\u2029]/;
export const isHeaderSafe = (v: string): boolean => !HEADER_UNSAFE.test(v);

/** Text that may be placed in a header: no CR, LF, NUL, other control characters or Unicode line separators. */
export const headerText = (max = 500) => z.string().max(max).refine(isHeaderSafe, { message: 'must not contain line breaks or control characters' });
/** Like {@link headerText}, one visible line for a file or folder name. */
const nameText = (max = 255) => z.string().min(1).max(max).refine(isHeaderSafe, { message: 'must not contain line breaks or control characters' });

const id = z.string().min(1).max(512);
const pageToken = z.string().min(1).max(2048);
const pageSize = z.number().int().min(1).max(MAX_PAGE_SIZE);
const email = z.email().max(254);
/** An instant with an explicit offset: `2026-03-02T09:30:00-05:00` or `...Z`. */
export const instant = z.iso.datetime({ offset: true });
const date = z.iso.date();
const ianaZone = z.string().min(1).max(64).regex(/^[A-Za-z0-9_+\-/]+$/);

export const pageOf = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextPageToken: z.string().nullable() });
export interface Page<T> {
  items: T[];
  /** Pass it back as `pageToken` for the next page; null on the last one. Opaque: a provider's own token. */
  nextPageToken: string | null;
}

export const mailAddress = z.object({ address: email, name: headerText(200).nullish() });
export type MailAddress = z.infer<typeof mailAddress>;

/** `person@example.test` or `{ address, name }` to the object form the schemas take. */
export const toMailAddress = (a: string | MailAddress): MailAddress => (typeof a === 'string' ? { address: a } : a);

// ---------------------------------------------------------------------------------------------------------------------------
// Mail

export const mailQuery = z.object({
  from: headerText(320).optional(),
  to: headerText(320).optional(),
  subject: headerText(500).optional(),
  /** Free text: matched as plain words. Query operators inside it are text, never operators. */
  text: z.string().max(500).optional(),
  after: instant.optional(),
  before: instant.optional(),
  /** A label id from `listLabels` (a system label such as `INBOX` or a user label). */
  label: id.optional(),
  unread: z.boolean().optional(),
  hasAttachment: z.boolean().optional(),
  pageSize: pageSize.optional(),
  pageToken: pageToken.optional(),
});
export type MailQuery = z.infer<typeof mailQuery>;

export const mailSummary = z.object({
  id,
  threadId: z.string().nullable(),
  from: mailAddress.nullable(),
  to: z.array(mailAddress),
  subject: z.string(),
  snippet: z.string(),
  date: instant.nullable(),
  unread: z.boolean(),
  hasAttachments: z.boolean(),
  labels: z.array(z.string()),
});
export type MailSummary = z.infer<typeof mailSummary>;

export const attachmentInfo = z.object({ id, filename: z.string(), contentType: z.string(), size: z.number().int().nonnegative() });
export type AttachmentInfo = z.infer<typeof attachmentInfo>;

export const mailGetOptions = z.object({ body: z.enum(['none', 'text', 'html']) });
export type MailGetOptions = z.infer<typeof mailGetOptions>;

export const mailMessage = mailSummary.extend({
  cc: z.array(mailAddress),
  replyTo: z.array(mailAddress),
  /** The RFC 5322 `Message-ID`, for threading a reply from outside. */
  internetMessageId: z.string().nullable(),
  /** The plain text (the plain part, or the HTML reduced to text). Null unless `body` was `text`. */
  text: z.string().nullable(),
  /** The HTML part. Null unless `body` was `html`. */
  html: z.string().nullable(),
  /** The text or html was cut at the body limit. */
  truncated: z.boolean(),
  attachments: z.array(attachmentInfo),
});
export type MailMessage = z.infer<typeof mailMessage>;

export const fileBytes = z.object({ filename: z.string(), contentType: z.string(), size: z.number().int().nonnegative(), bytes: z.instanceof(Buffer) });
export type FileBytes = z.infer<typeof fileBytes>;

export const outgoingAttachment = z.object({ filename: nameText(255), contentType: headerText(200).regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/), bytes: z.instanceof(Buffer) });
export type OutgoingAttachment = z.infer<typeof outgoingAttachment>;

/** `From` is always the connection's own address: there is no field to send as someone else. */
export const outgoingMail = z
  .object({
    to: z.array(mailAddress).min(1).max(MAX_RECIPIENTS),
    cc: z.array(mailAddress).max(MAX_RECIPIENTS).optional(),
    bcc: z.array(mailAddress).max(MAX_RECIPIENTS).optional(),
    subject: headerText(998),
    text: z.string().max(1_000_000).optional(),
    html: z.string().max(2_000_000).optional(),
    attachments: z.array(outgoingAttachment).max(20).optional(),
    /** Reply to this message (provider id): the adapter sets `In-Reply-To`, `References` and the thread. */
    inReplyTo: id.optional(),
    /**
     * Makes a retry of this send, after an ambiguous failure, return the first send instead of sending twice (a short-lived record
     * on the server; where the provider gives no id for a send it can only refuse the retry). Without a key, a retry may duplicate.
     */
    idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/).optional(),
  })
  .refine((m) => m.text !== undefined || m.html !== undefined, { message: 'text or html is required', path: ['text'] });
export type OutgoingMail = z.infer<typeof outgoingMail>;

export const draftRef = z.object({ draftId: id });
export type DraftRef = z.infer<typeof draftRef>;

export const mailModification = z.object({
  addLabels: z.array(id).max(20).optional(),
  removeLabels: z.array(id).max(20).optional(),
  read: z.boolean().optional(),
  archive: z.boolean().optional(),
});
export type MailModification = z.infer<typeof mailModification>;

export const mailLabel = z.object({ id, name: z.string(), kind: z.enum(['system', 'user']) });
export type MailLabel = z.infer<typeof mailLabel>;

export interface MailCapability {
  search(q: MailQuery): Promise<Page<MailSummary>>;
  get(id: string, opts: MailGetOptions): Promise<MailMessage>;
  /** Size-capped: over the attachment limit fails with TOO_LARGE before the bytes are fetched where the provider says the size. */
  getAttachment(messageId: string, attachmentId: string): Promise<FileBytes>;
  createDraft(m: OutgoingMail): Promise<{ draftId: string }>;
  /** A whole message needs `mail_send`; sending a saved draft also needs `mail_modify`. */
  send(m: OutgoingMail | DraftRef): Promise<{ messageId: string }>;
  modify(id: string, change: MailModification): Promise<void>;
  listLabels(): Promise<MailLabel[]>;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Calendar

export const calendarInfo = z.object({
  id,
  name: z.string(),
  primary: z.boolean(),
  timeZone: z.string().nullable(),
  accessRole: z.enum(['owner', 'writer', 'reader', 'freeBusy']),
});
export type CalendarInfo = z.infer<typeof calendarInfo>;

/** A timed event's start or end (`2026-03-02T09:30:00-05:00`), or a date for an all-day event (`2026-03-02`; the end is exclusive). */
export const eventTime = z.union([instant, date]);

export const attendeeInput = z.object({ address: email, name: headerText(200).nullish() });
export type AttendeeInput = z.infer<typeof attendeeInput>;

export const eventAttendee = z.object({ address: z.string(), name: z.string().nullable(), response: z.enum(['accepted', 'declined', 'tentative', 'needsAction']), organizer: z.boolean() });

export const calendarEvent = z.object({
  id,
  calendarId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  start: eventTime,
  end: eventTime,
  allDay: z.boolean(),
  timeZone: z.string().nullable(),
  status: z.enum(['confirmed', 'tentative', 'cancelled']),
  attendees: z.array(eventAttendee),
  recurring: z.boolean(),
  /** A video-conference link when the event has one. */
  conferenceUrl: z.string().nullable(),
  webUrl: z.string().nullable(),
});
export type CalendarEvent = z.infer<typeof calendarEvent>;

export const eventQuery = z.object({
  calendarId: id.optional(),
  from: instant,
  to: instant,
  text: z.string().max(500).optional(),
  pageSize: pageSize.optional(),
  pageToken: pageToken.optional(),
});
export type EventQuery = z.infer<typeof eventQuery>;

export const freeBusyQuery = z.object({ from: instant, to: instant, calendarIds: z.array(id).min(1).max(20).optional() });
export type FreeBusyQuery = z.infer<typeof freeBusyQuery>;
export const busyBlock = z.object({ calendarId: z.string(), start: instant, end: instant });
export type BusyBlock = z.infer<typeof busyBlock>;

export const newEvent = z.object({
  calendarId: id.optional(),
  title: headerText(500).min(1),
  description: z.string().max(8_000).optional(),
  location: headerText(500).optional(),
  start: eventTime,
  end: eventTime,
  /** IANA zone for the event (default: the calendar's). The times keep their explicit offsets. */
  timeZone: ianaZone.optional(),
  attendees: z.array(attendeeInput).max(MAX_ATTENDEES).optional(),
  /** Email the attendees about this event. Default `false`: an agent must not email people by side effect. */
  notifyAttendees: z.boolean().optional(),
  /** Add a video conference. Default `false`. */
  conference: z.boolean().optional(),
  /** Makes a retried create return the first event instead of a duplicate (the provider's own id scheme where it has one). */
  idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/).optional(),
});
export type NewEvent = z.infer<typeof newEvent>;

export const eventPatch = z.object({
  calendarId: id.optional(),
  title: headerText(500).min(1).optional(),
  description: z.string().max(8_000).nullable().optional(),
  location: headerText(500).nullable().optional(),
  start: eventTime.optional(),
  end: eventTime.optional(),
  timeZone: ianaZone.optional(),
  /** Replaces the attendee list. */
  attendees: z.array(attendeeInput).max(MAX_ATTENDEES).optional(),
  notifyAttendees: z.boolean().optional(),
});
export type EventPatch = z.infer<typeof eventPatch>;

export const deleteEventOptions = z.object({ notifyAttendees: z.boolean(), calendarId: id.optional() });
export type DeleteEventOptions = z.infer<typeof deleteEventOptions>;

export interface CalendarCapability {
  listCalendars(): Promise<CalendarInfo[]>;
  listEvents(q: EventQuery): Promise<Page<CalendarEvent>>;
  freeBusy(q: FreeBusyQuery): Promise<BusyBlock[]>;
  createEvent(e: NewEvent): Promise<CalendarEvent>;
  updateEvent(id: string, patch: EventPatch): Promise<CalendarEvent>;
  deleteEvent(id: string, opts: DeleteEventOptions): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Documents

export const FILE_KINDS = ['document', 'spreadsheet', 'folder', 'pdf', 'other'] as const;
export const fileInfo = z.object({
  id,
  name: z.string(),
  kind: z.enum(FILE_KINDS),
  mimeType: z.string(),
  size: z.number().int().nonnegative().nullable(),
  modifiedAt: instant.nullable(),
  webUrl: z.string().nullable(),
  parentId: z.string().nullable(),
});
export type FileInfo = z.infer<typeof fileInfo>;

export const fileQuery = z.object({
  /** Words in the file's name or content, as plain text. */
  text: z.string().max(500).optional(),
  type: z.enum(['document', 'spreadsheet', 'folder', 'pdf', 'any']).optional(),
  folderId: id.optional(),
  pageSize: pageSize.optional(),
  pageToken: pageToken.optional(),
});
export type FileQuery = z.infer<typeof fileQuery>;

export const documentText = z.object({ text: z.string(), truncated: z.boolean() });
export type DocumentText = z.infer<typeof documentText>;

/** A cell value. Written raw: a string starting with `=` is text, never a formula. */
export const cell = z.union([z.string().max(50_000), z.number().finite(), z.boolean(), z.null()]);
export type Cell = z.infer<typeof cell>;

const A1 = /^[A-Za-z]{1,3}[0-9]{0,7}(:[A-Za-z]{1,3}[0-9]{0,7})?$/;
export const sheetRange = z.object({
  /** The tab's name (default: the first tab). */
  sheet: nameText(100).optional(),
  /** `A1:D20`, `A:C` (default: the whole used range, up to the cell limit). */
  range: z.string().regex(A1).optional(),
});
export type SheetRange = z.infer<typeof sheetRange>;

export const sheetValues = z.object({ values: z.array(z.array(cell)), truncated: z.boolean() });
export type SheetValues = z.infer<typeof sheetValues>;

export const appendResult = z.object({
  /** Where the rows landed (`Sheet1!A12:C13`); null when the outcome is ambiguous. */
  updatedRange: z.string().nullable(),
  /**
   * The request failed in a way that leaves it unknown whether the rows were written (a timeout, a connection reset). It was NOT
   * retried: a blind retry could duplicate the rows. The caller decides (read the sheet, or accept a possible duplicate).
   */
  ambiguous: z.boolean(),
});
export type AppendResult = z.infer<typeof appendResult>;

export const newDocument = z.object({ title: nameText(255), text: z.string().max(1_000_000), folderId: id.optional() });
export const newSpreadsheet = z.object({ title: nameText(255), headers: z.array(z.string().max(500)).max(100).optional(), folderId: id.optional() });
export const uploadInput = z.object({ name: nameText(255), contentType: headerText(200).regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/), bytes: z.instanceof(Buffer), folderId: id.optional() });
export const newFolder = z.object({ name: nameText(255), parentId: id.optional() });
export type NewDocument = z.infer<typeof newDocument>;
export type NewSpreadsheet = z.infer<typeof newSpreadsheet>;
export type UploadInput = z.infer<typeof uploadInput>;
export type NewFolder = z.infer<typeof newFolder>;

export interface DocumentsCapability {
  /** At Google with the narrow `drive.file` permission this sees only files the app created or the owner picked (docs/connections.md, "Google"). */
  searchFiles(q: FileQuery): Promise<Page<FileInfo>>;
  getFile(id: string): Promise<FileInfo>;
  /**
   * Confirms that the connection can reach a file the owner picked (Google Picker, E39.10) or pasted, and returns its details.
   * A file it cannot reach is PERMISSION_MISSING (not picked) or NOT_FOUND.
   */
  registerPickedFile(id: string): Promise<FileInfo>;
  readDocument(id: string): Promise<DocumentText>;
  createDocument(d: NewDocument): Promise<FileInfo>;
  appendToDocument(id: string, text: string): Promise<void>;
  readSheet(id: string, range: SheetRange): Promise<SheetValues>;
  appendRows(id: string, sheet: string | undefined, rows: Cell[][]): Promise<AppendResult>;
  createSpreadsheet(s: NewSpreadsheet): Promise<FileInfo>;
  uploadFile(f: UploadInput): Promise<FileInfo>;
  createFolder(f: NewFolder): Promise<FileInfo>;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The method table: the tag (read or write, the capability), the argument schema and the result schema of every method.

export type CapabilityService = 'mail' | 'calendar' | 'documents';
export type Effect = 'read' | 'write';

export interface MethodSpec {
  service: CapabilityService;
  effect: Effect;
  /** The capability the connection must have switched on (and the provider must have granted). */
  capability: Capability;
  /** More capabilities some argument shapes need (sending a saved draft also needs `mail_modify`). */
  alsoNeeds?: (args: readonly unknown[]) => Capability[];
  args: z.ZodType<unknown[]>;
  result: z.ZodType<unknown>;
}

const noArgs = z.tuple([]);
const spec = (s: MethodSpec): MethodSpec => s;
const voidResult = z.undefined().or(z.null()).or(z.void());

export const MAIL_METHODS = {
  search: spec({ service: 'mail', effect: 'read', capability: 'mail_read', args: z.tuple([mailQuery]), result: pageOf(mailSummary) }),
  get: spec({ service: 'mail', effect: 'read', capability: 'mail_read', args: z.tuple([id, mailGetOptions]), result: mailMessage }),
  getAttachment: spec({ service: 'mail', effect: 'read', capability: 'mail_read', args: z.tuple([id, id]), result: fileBytes }),
  createDraft: spec({ service: 'mail', effect: 'write', capability: 'mail_modify', args: z.tuple([outgoingMail]), result: z.object({ draftId: id }) }),
  send: spec({
    service: 'mail',
    effect: 'write',
    capability: 'mail_send',
    alsoNeeds: (args) => (draftRef.safeParse(args[0]).success ? ['mail_modify'] : []),
    args: z.tuple([z.union([draftRef, outgoingMail])]),
    result: z.object({ messageId: id }),
  }),
  modify: spec({ service: 'mail', effect: 'write', capability: 'mail_modify', args: z.tuple([id, mailModification]), result: voidResult }),
  listLabels: spec({ service: 'mail', effect: 'read', capability: 'mail_read', args: noArgs, result: z.array(mailLabel) }),
} as const satisfies Record<keyof MailCapability, MethodSpec>;

export const CALENDAR_METHODS = {
  listCalendars: spec({ service: 'calendar', effect: 'read', capability: 'calendar_read', args: noArgs, result: z.array(calendarInfo) }),
  listEvents: spec({ service: 'calendar', effect: 'read', capability: 'calendar_read', args: z.tuple([eventQuery]), result: pageOf(calendarEvent) }),
  freeBusy: spec({ service: 'calendar', effect: 'read', capability: 'calendar_read', args: z.tuple([freeBusyQuery]), result: z.array(busyBlock) }),
  createEvent: spec({ service: 'calendar', effect: 'write', capability: 'calendar_write', args: z.tuple([newEvent]), result: calendarEvent }),
  updateEvent: spec({ service: 'calendar', effect: 'write', capability: 'calendar_write', args: z.tuple([id, eventPatch]), result: calendarEvent }),
  deleteEvent: spec({ service: 'calendar', effect: 'write', capability: 'calendar_write', args: z.tuple([id, deleteEventOptions]), result: voidResult }),
} as const satisfies Record<keyof CalendarCapability, MethodSpec>;

export const DOCUMENT_METHODS = {
  searchFiles: spec({ service: 'documents', effect: 'read', capability: 'docs_read', args: z.tuple([fileQuery]), result: pageOf(fileInfo) }),
  getFile: spec({ service: 'documents', effect: 'read', capability: 'docs_read', args: z.tuple([id]), result: fileInfo }),
  registerPickedFile: spec({ service: 'documents', effect: 'read', capability: 'docs_read', args: z.tuple([id]), result: fileInfo }),
  readDocument: spec({ service: 'documents', effect: 'read', capability: 'docs_read', args: z.tuple([id]), result: documentText }),
  createDocument: spec({ service: 'documents', effect: 'write', capability: 'docs_write', args: z.tuple([newDocument]), result: fileInfo }),
  appendToDocument: spec({ service: 'documents', effect: 'write', capability: 'docs_write', args: z.tuple([id, z.string().min(1).max(1_000_000)]), result: voidResult }),
  readSheet: spec({ service: 'documents', effect: 'read', capability: 'docs_read', args: z.tuple([id, sheetRange]), result: sheetValues }),
  appendRows: spec({
    service: 'documents',
    effect: 'write',
    capability: 'docs_write',
    args: z.tuple([id, nameText(100).optional(), z.array(z.array(cell).min(1).max(200)).min(1).max(500)]),
    result: appendResult,
  }),
  createSpreadsheet: spec({ service: 'documents', effect: 'write', capability: 'docs_write', args: z.tuple([newSpreadsheet]), result: fileInfo }),
  uploadFile: spec({ service: 'documents', effect: 'write', capability: 'docs_write', args: z.tuple([uploadInput]), result: fileInfo }),
  createFolder: spec({ service: 'documents', effect: 'write', capability: 'docs_write', args: z.tuple([newFolder]), result: fileInfo }),
} as const satisfies Record<keyof DocumentsCapability, MethodSpec>;

export const CAPABILITY_METHODS = { mail: MAIL_METHODS, calendar: CALENDAR_METHODS, documents: DOCUMENT_METHODS } as const;

export interface MethodTag {
  service: CapabilityService;
  method: string;
  effect: Effect;
  capability: Capability;
}

/** Every method with its effect and capability: `mail.send` is a write needing `mail_send`. For the docs, for approval gating (E39.7) and for tests. */
export const METHOD_TAGS: readonly MethodTag[] = (Object.entries(CAPABILITY_METHODS) as [CapabilityService, Record<string, MethodSpec>][]).flatMap(([service, methods]) =>
  Object.entries(methods).map(([method, s]) => ({ service, method, effect: s.effect, capability: s.capability })),
);

/** The tag of one method. */
export function methodTag(service: CapabilityService, method: string): MethodTag | undefined {
  return METHOD_TAGS.find((t) => t.service === service && t.method === method);
}

/** Every capability a call needs: its own plus those its arguments add. */
export function capabilitiesNeeded(s: MethodSpec, args: readonly unknown[]): Capability[] {
  return [...new Set([s.capability, ...(s.alsoNeeds?.(args) ?? [])])];
}

/** The capabilities each service can use, for a UI or a tool to know which switches matter. */
export const SERVICE_CAPABILITIES: Record<CapabilityService, readonly Capability[]> = {
  mail: ['mail_read', 'mail_send', 'mail_modify'],
  calendar: ['calendar_read', 'calendar_write'],
  documents: ['docs_read', 'docs_write'],
};

// ---------------------------------------------------------------------------------------------------------------------------
// Limits applied to what an adapter returns (a safety net: adapters stop fetching early, this guarantees the contract)

const cut = (s: string | null, max: number): { value: string | null; cut: boolean } => (s !== null && s.length > max ? { value: s.slice(0, max), cut: true } : { value: s, cut: false });

export function limitMessage(m: MailMessage, limits: CapabilityLimits): MailMessage {
  const t = cut(m.text, limits.bodyChars);
  const h = cut(m.html, limits.bodyChars);
  return t.cut || h.cut ? { ...m, text: t.value, html: h.value, truncated: true } : m;
}

export function limitDocument(d: DocumentText, limits: CapabilityLimits): DocumentText {
  const t = cut(d.text, limits.bodyChars);
  return t.cut ? { text: t.value ?? '', truncated: true } : d;
}

export function limitSheet(s: SheetValues, limits: CapabilityLimits): SheetValues {
  let cells = 0;
  const values: Cell[][] = [];
  for (const row of s.values) {
    if (cells + row.length > limits.sheetCells) {
      const room = limits.sheetCells - cells;
      if (room > 0) values.push(row.slice(0, room));
      return { values, truncated: true };
    }
    cells += row.length;
    values.push(row);
  }
  return s;
}

export const cellCount = (rows: readonly (readonly unknown[])[]): number => rows.reduce((n, r) => n + r.length, 0);

/** The limits on an INPUT the schema cannot know (they are configurable): a too-large item is TOO_LARGE, not INVALID_INPUT. */
export function checkInputLimits(service: CapabilityService, method: string, args: readonly unknown[], limits: CapabilityLimits): void {
  const tooLarge = (reason: string): never => {
    throw new CapabilityError('TOO_LARGE', { reason });
  };
  if (service === 'mail' && (method === 'send' || method === 'createDraft')) {
    const m = args[0] as Partial<OutgoingMail> | undefined;
    const atts = m?.attachments ?? [];
    if (atts.some((a) => a.bytes.length > limits.attachmentBytes)) tooLarge('ATTACHMENT_BYTES');
    if (atts.reduce((n, a) => n + a.bytes.length, 0) > limits.outgoingMailBytes) tooLarge('MESSAGE_BYTES');
    if ((m?.text?.length ?? 0) > limits.bodyChars * 20 || (m?.html?.length ?? 0) > limits.bodyChars * 40) tooLarge('BODY_CHARS');
  }
  if (service === 'documents' && method === 'uploadFile') {
    if ((args[0] as UploadInput).bytes.length > limits.attachmentBytes) tooLarge('FILE_BYTES');
  }
  if (service === 'documents' && method === 'appendRows') {
    if (cellCount(args[2] as Cell[][]) > limits.sheetCells) tooLarge('SHEET_CELLS');
  }
}

/** Applies the output limit of the methods that have one. */
export function limitResult(service: CapabilityService, method: string, result: unknown, limits: CapabilityLimits): unknown {
  if (service === 'mail' && method === 'get') return limitMessage(result as MailMessage, limits);
  if (service === 'mail' && method === 'getAttachment') {
    if ((result as FileBytes).bytes.length > limits.attachmentBytes) throw new CapabilityError('TOO_LARGE', { reason: 'ATTACHMENT_BYTES' });
    return result;
  }
  if (service === 'documents' && method === 'readDocument') return limitDocument(result as DocumentText, limits);
  if (service === 'documents' && method === 'readSheet') return limitSheet(result as SheetValues, limits);
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The provider side: what an adapter offers and what it receives

/** What an adapter is handed for one bound capability object: who, which account, the signal and the limits. */
export interface CapabilityContext extends ConnectionContext {
  limits: CapabilityLimits;
  /** The connection as it is now: its provider, the address (the `From` of mail) and the switches that are on. */
  connection: { provider: ConnectionProviderId; label: string; accountEmail: string; capabilities: Capability[]; /** The provider's stable account id (Microsoft: `<tenant id>:<object id>`, which tells a personal account from a work one). */ accountId?: string };
}

/**
 * One provider's implementation of the capability interfaces. `mail`, `calendar` and `documents` build an object bound to one
 * call context; the object's methods get validated arguments and may rely on them. An adapter omits a service it does not offer (or returns undefined).
 */
export interface CapabilityProvider {
  readonly provider: ConnectionProviderId;
  mail?(ctx: CapabilityContext): MailCapability | undefined;
  calendar?(ctx: CapabilityContext): CalendarCapability | undefined;
  documents?(ctx: CapabilityContext): DocumentsCapability | undefined;
}

export { isCapability };
