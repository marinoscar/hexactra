// An in-memory capability provider for tests of everything that USES connections (E39.3, #601): deliveries (E39.6), agent tools
// (E39.7), the mail trigger (E39.8). It implements `CapabilityProvider` for mail, calendar and documents with no network and keeps
// one separate "account" per connection id, so a test with two connections proves that nothing crosses. Invented data only.
//
//   const fake = new FakeCapabilityProvider('google');
//   fake.account(conn.id).addMessage({ subject: 'Hello', from: 'person-b@example.test' });
//   registry.register(fake);                 // CapabilityProviderRegistry, or `createTestCapabilities()` below
//   ...call the code under test...
//   expect(fake.account(conn.id).sent).toHaveLength(1);
//
// It is a double, not a model of any provider: it checks what the neutral contract promises (paging, raw sheet values, notify
// defaults, idempotency keys, the abort signal) and can be told to fail (`failNext`). The gates (capability off, permission
// missing, validation, limits) are the hub's, not the fake's, so they behave the same here as with a real adapter.
import { randomUUID } from 'node:crypto';

import {
  CapabilityError,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  notifyAttendeesOf,
  type AppendResult,
  type AttendeeInput,
  type BusyBlock,
  type CalendarCapability,
  type CalendarEvent,
  type CalendarInfo,
  type Cell,
  type CapabilityContext,
  type CapabilityProvider,
  type DeleteEventOptions,
  type DocumentsCapability,
  type EventPatch,
  type EventQuery,
  type FileBytes,
  type FileInfo,
  type FileQuery,
  type FreeBusyQuery,
  type MailAddress,
  type MailCapability,
  type MailGetOptions,
  type MailLabel,
  type MailMessage,
  type MailModification,
  type MailQuery,
  type MailSummary,
  type NewEvent,
  type NewFolder,
  type NewSpreadsheet,
  type NewDocument,
  type OutgoingMail,
  type Page,
  type SheetRange,
  type SheetValues,
  type UploadInput,
  type DraftRef,
  type DocumentText,
} from '../capabilities';
import type { ConnectionProviderId } from '../connections.constants';

export interface FakeAttachment {
  id: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
}

export interface FakeMessage {
  id: string;
  threadId: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  text: string;
  html: string | null;
  /** ISO instant with offset. */
  date: string;
  unread: boolean;
  labels: string[];
  attachments: FakeAttachment[];
  /** What the provider's sender authentication says about the From address (`get` returns it; absent is `unknown`). */
  senderAuth?: 'pass' | 'fail' | 'unknown';
}

export type FakeMessageInput = Partial<Omit<FakeMessage, 'from' | 'to' | 'cc' | 'attachments'>> & { from?: string | MailAddress; to?: (string | MailAddress)[]; cc?: (string | MailAddress)[]; attachments?: Partial<FakeAttachment>[] };

const addr = (a: string | MailAddress): MailAddress => (typeof a === 'string' ? { address: a, name: null } : { address: a.address, name: a.name ?? null });
const newId = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`;

/** A record of one write the fake received, for assertions on side effects. */
export interface FakeWrite {
  method: string;
  /** The `notifyAttendees` the call carried, as the adapter would send it (false when omitted). */
  notifyAttendees?: boolean;
  id?: string;
}

/** One connection's mailbox, calendar and drive. */
export class FakeAccount {
  readonly labels: MailLabel[] = ['INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM', 'STARRED', 'UNREAD'].map((n) => ({ id: n, name: n, kind: 'system' as const }));
  readonly messages: FakeMessage[] = [];
  readonly drafts = new Map<string, OutgoingMail>();
  /** Every message sent (a whole message, or a draft), in order. */
  readonly sent: (OutgoingMail & { messageId: string })[] = [];
  readonly calendars: CalendarInfo[] = [{ id: 'primary', name: 'Primary', primary: true, timeZone: 'UTC', accessRole: 'owner' }];
  readonly events: CalendarEvent[] = [];
  readonly busy: BusyBlock[] = [];
  readonly files: FileInfo[] = [];
  readonly docs = new Map<string, string>();
  /** Spreadsheet id to tab name to rows, exactly as written: a cell `=SUM(A1)` stays that text. */
  readonly sheets = new Map<string, Map<string, Cell[][]>>();
  readonly uploads = new Map<string, Buffer>();
  readonly writes: FakeWrite[] = [];
  readonly eventKeys = new Map<string, string>();
  /** Files the owner "picked" (`registerPickedFile` fails for any other id when `restrictToPicked` is on). */
  readonly picked = new Set<string>();
  restrictToPicked = false;

  addMessage(input: FakeMessageInput = {}): FakeMessage {
    const id = input.id ?? newId('msg');
    const m: FakeMessage = {
      id,
      threadId: input.threadId ?? `thr-${id}`,
      from: addr(input.from ?? 'person-b@example.test'),
      to: (input.to ?? ['person-a@example.test']).map(addr),
      cc: (input.cc ?? []).map(addr),
      subject: input.subject ?? 'Subject',
      text: input.text ?? 'Body',
      html: input.html ?? null,
      date: input.date ?? new Date().toISOString(),
      unread: input.unread ?? true,
      labels: input.labels ?? ['INBOX'],
      attachments: (input.attachments ?? []).map((a) => ({ id: a.id ?? newId('att'), filename: a.filename ?? 'file.bin', contentType: a.contentType ?? 'application/octet-stream', bytes: a.bytes ?? Buffer.from('x') })),
      ...(input.senderAuth ? { senderAuth: input.senderAuth } : {}),
    };
    this.messages.push(m);
    return m;
  }

  addFile(f: Partial<FileInfo> & { name: string }): FileInfo {
    const file: FileInfo = { id: f.id ?? newId('file'), name: f.name, kind: f.kind ?? 'other', mimeType: f.mimeType ?? 'application/octet-stream', size: f.size ?? null, modifiedAt: f.modifiedAt ?? new Date().toISOString(), webUrl: f.webUrl ?? null, parentId: f.parentId ?? null };
    this.files.push(file);
    return file;
  }

  addEvent(e: Partial<CalendarEvent> & { title: string; start: string; end: string }): CalendarEvent {
    const ev: CalendarEvent = {
      id: e.id ?? newId('evt'),
      calendarId: e.calendarId ?? 'primary',
      title: e.title,
      description: e.description ?? null,
      location: e.location ?? null,
      start: e.start,
      end: e.end,
      allDay: !e.start.includes('T'),
      timeZone: e.timeZone ?? null,
      status: e.status ?? 'confirmed',
      attendees: e.attendees ?? [],
      recurring: e.recurring ?? false,
      conferenceUrl: e.conferenceUrl ?? null,
      webUrl: null,
    };
    this.events.push(ev);
    return ev;
  }
}

export interface FakeCall {
  service: 'mail' | 'calendar' | 'documents';
  method: string;
  connectionId: string;
  args: unknown[];
}

const page = <T>(all: T[], q: { pageSize?: number; pageToken?: string }): Page<T> => {
  const size = Math.min(MAX_PAGE_SIZE, q.pageSize ?? DEFAULT_PAGE_SIZE);
  const start = q.pageToken ? Number(q.pageToken) || 0 : 0;
  const items = all.slice(start, start + size);
  return { items, nextPageToken: start + size < all.length ? String(start + size) : null };
};

const has = (hay: string, needle: string | undefined): boolean => !needle || hay.toLowerCase().includes(needle.toLowerCase());
const summary = (m: FakeMessage): MailSummary => ({ id: m.id, threadId: m.threadId, from: m.from, to: m.to, subject: m.subject, snippet: m.text.slice(0, 100), date: m.date, unread: m.unread, hasAttachments: m.attachments.length > 0, labels: m.labels, ...(m.senderAuth ? { senderAuth: m.senderAuth } : {}) });

export class FakeCapabilityProvider implements CapabilityProvider {
  /** Every call, in order (the arguments are the validated ones). */
  readonly calls: FakeCall[] = [];
  /** Milliseconds each call takes (to test Stop). */
  latencyMs = 0;
  private readonly accounts = new Map<string, FakeAccount>();
  private readonly failures: { key: string; error: Error; times: number }[] = [];
  /** Services this provider does not offer (the hub answers NOT_SUPPORTED). */
  readonly without = new Set<'mail' | 'calendar' | 'documents'>();

  constructor(readonly provider: ConnectionProviderId = 'google') {}

  /** The account behind a connection id (created empty on first use). */
  account(connectionId: string): FakeAccount {
    let a = this.accounts.get(connectionId);
    if (!a) this.accounts.set(connectionId, (a = new FakeAccount()));
    return a;
  }

  /** The next `times` calls of `service.method` (or of any method with `*`) fail with `error`. */
  failNext(key: string, error: Error = new CapabilityError('PROVIDER_ERROR', { status: 500 }), times = 1): void {
    this.failures.push({ key, error, times });
  }

  callsOf(key: string): FakeCall[] {
    return this.calls.filter((c) => `${c.service}.${c.method}` === key);
  }

  private async enter(ctx: CapabilityContext, service: FakeCall['service'], method: string, args: unknown[]): Promise<FakeAccount> {
    this.calls.push({ service, method, connectionId: ctx.connectionId, args });
    if (ctx.signal?.aborted) throw new CapabilityError('ABORTED');
    if (this.latencyMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.latencyMs);
        ctx.signal?.addEventListener('abort', () => (clearTimeout(t), reject(new CapabilityError('ABORTED'))), { once: true });
      });
    }
    const f = this.failures.find((x) => (x.key === `${service}.${method}` || x.key === '*') && x.times > 0);
    if (f) {
      f.times--;
      throw f.error;
    }
    return this.account(ctx.connectionId);
  }

  mail(ctx: CapabilityContext): MailCapability | undefined {
    if (this.without.has('mail')) return undefined;
    return {
      search: async (q: MailQuery) => {
        const a = await this.enter(ctx, 'mail', 'search', [q]);
        const hits = a.messages.filter(
          (m) =>
            has(m.from.address + ' ' + (m.from.name ?? ''), q.from) &&
            has(m.to.map((t) => t.address).join(' '), q.to) &&
            has(m.subject, q.subject) &&
            has(`${m.subject} ${m.text}`, q.text) &&
            (!q.after || m.date >= q.after) &&
            (!q.before || m.date < q.before) &&
            (!q.label || m.labels.includes(q.label)) &&
            (q.unread === undefined || m.unread === q.unread) &&
            (q.hasAttachment === undefined || m.attachments.length > 0 === q.hasAttachment),
        );
        return page(hits.map(summary), q);
      },
      get: async (id: string, opts: MailGetOptions): Promise<MailMessage> => {
        const a = await this.enter(ctx, 'mail', 'get', [id, opts]);
        const m = a.messages.find((x) => x.id === id);
        if (!m) throw new CapabilityError('NOT_FOUND');
        return {
          ...summary(m),
          cc: m.cc,
          replyTo: [],
          internetMessageId: `<${m.id}@example.test>`,
          text: opts.body === 'text' ? m.text : null,
          html: opts.body === 'html' ? (m.html ?? m.text) : null,
          truncated: false,
          attachments: m.attachments.map((x) => ({ id: x.id, filename: x.filename, contentType: x.contentType, size: x.bytes.length })),
          ...(m.senderAuth ? { senderAuth: m.senderAuth } : {}),
        };
      },
      getAttachment: async (messageId: string, attachmentId: string): Promise<FileBytes> => {
        const a = await this.enter(ctx, 'mail', 'getAttachment', [messageId, attachmentId]);
        const att = a.messages.find((x) => x.id === messageId)?.attachments.find((x) => x.id === attachmentId);
        if (!att) throw new CapabilityError('NOT_FOUND');
        if (att.bytes.length > ctx.limits.attachmentBytes) throw new CapabilityError('TOO_LARGE', { reason: 'ATTACHMENT_BYTES' });
        return { filename: att.filename, contentType: att.contentType, size: att.bytes.length, bytes: att.bytes };
      },
      createDraft: async (m: OutgoingMail) => {
        const a = await this.enter(ctx, 'mail', 'createDraft', [m]);
        const draftId = newId('draft');
        a.drafts.set(draftId, m);
        return { draftId };
      },
      send: async (m: OutgoingMail | DraftRef) => {
        const a = await this.enter(ctx, 'mail', 'send', [m]);
        let mail: OutgoingMail;
        if ('draftId' in m) {
          const d = a.drafts.get(m.draftId);
          if (!d) throw new CapabilityError('NOT_FOUND');
          a.drafts.delete(m.draftId);
          mail = d;
        } else mail = m;
        const messageId = newId('sent');
        a.sent.push({ ...mail, messageId });
        a.writes.push({ method: 'mail.send', id: messageId });
        return { messageId };
      },
      modify: async (id: string, change: MailModification) => {
        const a = await this.enter(ctx, 'mail', 'modify', [id, change]);
        const m = a.messages.find((x) => x.id === id);
        if (!m) throw new CapabilityError('NOT_FOUND');
        m.labels = [...new Set([...m.labels, ...(change.addLabels ?? [])])].filter((l) => !(change.removeLabels ?? []).includes(l) && !(change.archive && l === 'INBOX'));
        if (change.read !== undefined) m.unread = !change.read;
      },
      listLabels: async () => (await this.enter(ctx, 'mail', 'listLabels', []), [...this.account(ctx.connectionId).labels]),
    };
  }

  calendar(ctx: CapabilityContext): CalendarCapability | undefined {
    if (this.without.has('calendar')) return undefined;
    return {
      listCalendars: async () => (await this.enter(ctx, 'calendar', 'listCalendars', []), [...this.account(ctx.connectionId).calendars]),
      listEvents: async (q: EventQuery) => {
        const a = await this.enter(ctx, 'calendar', 'listEvents', [q]);
        const cal = q.calendarId ?? 'primary';
        return page(a.events.filter((e) => e.calendarId === cal && e.end > q.from && e.start < q.to && has(`${e.title} ${e.description ?? ''}`, q.text)), q);
      },
      freeBusy: async (q: FreeBusyQuery) => {
        const a = await this.enter(ctx, 'calendar', 'freeBusy', [q]);
        return a.busy.filter((b) => b.end > q.from && b.start < q.to && (!q.calendarIds || q.calendarIds.includes(b.calendarId)));
      },
      createEvent: async (e: NewEvent) => {
        const a = await this.enter(ctx, 'calendar', 'createEvent', [e]);
        const prior = e.idempotencyKey ? a.eventKeys.get(e.idempotencyKey) : undefined;
        const existing = prior ? a.events.find((x) => x.id === prior) : undefined;
        if (existing) return existing;
        const ev = a.addEvent({
          calendarId: e.calendarId ?? 'primary',
          title: e.title,
          description: e.description ?? null,
          location: e.location ?? null,
          start: e.start,
          end: e.end,
          timeZone: e.timeZone ?? null,
          attendees: (e.attendees ?? []).map((x: AttendeeInput) => ({ address: x.address, name: x.name ?? null, response: 'needsAction' as const, organizer: false })),
          conferenceUrl: e.conference === true ? 'https://meet.example.test/fake' : null,
        });
        if (e.idempotencyKey) a.eventKeys.set(e.idempotencyKey, ev.id);
        a.writes.push({ method: 'calendar.createEvent', notifyAttendees: notifyAttendeesOf(e), id: ev.id });
        return ev;
      },
      updateEvent: async (id: string, patch: EventPatch) => {
        const a = await this.enter(ctx, 'calendar', 'updateEvent', [id, patch]);
        const ev = a.events.find((x) => x.id === id);
        if (!ev) throw new CapabilityError('NOT_FOUND');
        if (patch.title !== undefined) ev.title = patch.title;
        if (patch.description !== undefined) ev.description = patch.description;
        if (patch.location !== undefined) ev.location = patch.location;
        if (patch.start !== undefined) ev.start = patch.start;
        if (patch.end !== undefined) ev.end = patch.end;
        if (patch.attendees) ev.attendees = patch.attendees.map((x) => ({ address: x.address, name: x.name ?? null, response: 'needsAction' as const, organizer: false }));
        a.writes.push({ method: 'calendar.updateEvent', notifyAttendees: notifyAttendeesOf(patch), id });
        return ev;
      },
      deleteEvent: async (id: string, opts: DeleteEventOptions) => {
        const a = await this.enter(ctx, 'calendar', 'deleteEvent', [id, opts]);
        const i = a.events.findIndex((x) => x.id === id);
        if (i < 0) throw new CapabilityError('NOT_FOUND');
        a.events.splice(i, 1);
        a.writes.push({ method: 'calendar.deleteEvent', notifyAttendees: notifyAttendeesOf(opts), id });
      },
    };
  }

  documents(ctx: CapabilityContext): DocumentsCapability | undefined {
    if (this.without.has('documents')) return undefined;
    const kindOf = (t: FileQuery['type']): FileInfo['kind'] | null => (t && t !== 'any' ? t : null);
    return {
      searchFiles: async (q: FileQuery) => {
        const a = await this.enter(ctx, 'documents', 'searchFiles', [q]);
        const k = kindOf(q.type);
        return page(a.files.filter((f) => has(f.name, q.text) && (!k || f.kind === k) && (!q.folderId || f.parentId === q.folderId)), q);
      },
      getFile: async (id: string) => {
        const a = await this.enter(ctx, 'documents', 'getFile', [id]);
        const f = a.files.find((x) => x.id === id);
        if (!f) throw new CapabilityError('NOT_FOUND');
        return f;
      },
      registerPickedFile: async (id: string) => {
        const a = await this.enter(ctx, 'documents', 'registerPickedFile', [id]);
        const f = a.files.find((x) => x.id === id);
        if (!f) throw new CapabilityError('NOT_FOUND');
        if (a.restrictToPicked && !a.picked.has(id) && !f.id.startsWith('created-')) throw new CapabilityError('PERMISSION_MISSING', { capability: 'docs_read', reason: 'NOT_PICKED' });
        return f;
      },
      readDocument: async (id: string): Promise<DocumentText> => {
        const a = await this.enter(ctx, 'documents', 'readDocument', [id]);
        const t = a.docs.get(id);
        if (t === undefined) throw new CapabilityError('NOT_FOUND');
        return { text: t, truncated: false };
      },
      createDocument: async (d: NewDocument) => {
        const a = await this.enter(ctx, 'documents', 'createDocument', [d]);
        const f = a.addFile({ id: newId('created-doc'), name: d.title, kind: 'document', mimeType: 'application/vnd.google-apps.document', parentId: d.folderId ?? null });
        a.docs.set(f.id, d.text);
        a.writes.push({ method: 'documents.createDocument', id: f.id });
        return f;
      },
      appendToDocument: async (id: string, text: string) => {
        const a = await this.enter(ctx, 'documents', 'appendToDocument', [id, text]);
        if (!a.docs.has(id)) throw new CapabilityError('NOT_FOUND');
        a.docs.set(id, a.docs.get(id)! + text);
        a.writes.push({ method: 'documents.appendToDocument', id });
      },
      readSheet: async (id: string, range: SheetRange): Promise<SheetValues> => {
        const a = await this.enter(ctx, 'documents', 'readSheet', [id, range]);
        const tabs = a.sheets.get(id);
        if (!tabs) throw new CapabilityError('NOT_FOUND');
        const rows = tabs.get(range.sheet ?? [...tabs.keys()][0]!);
        if (!rows) throw new CapabilityError('NOT_FOUND');
        return { values: rows.map((r) => [...r]), truncated: false };
      },
      appendRows: async (id: string, sheet: string | undefined, rows: Cell[][]): Promise<AppendResult> => {
        const a = await this.enter(ctx, 'documents', 'appendRows', [id, sheet, rows]);
        const tabs = a.sheets.get(id);
        if (!tabs) throw new CapabilityError('NOT_FOUND');
        const tab = sheet ?? [...tabs.keys()][0]!;
        const existing = tabs.get(tab);
        if (!existing) throw new CapabilityError('NOT_FOUND');
        const first = existing.length + 1;
        existing.push(...rows.map((r) => [...r]));
        a.writes.push({ method: 'documents.appendRows', id });
        return { updatedRange: `${tab}!A${first}:${String.fromCharCode(64 + Math.max(...rows.map((r) => r.length)))}${existing.length}`, ambiguous: false };
      },
      createSpreadsheet: async (s: NewSpreadsheet) => {
        const a = await this.enter(ctx, 'documents', 'createSpreadsheet', [s]);
        const f = a.addFile({ id: newId('created-sheet'), name: s.title, kind: 'spreadsheet', mimeType: 'application/vnd.google-apps.spreadsheet', parentId: s.folderId ?? null });
        a.sheets.set(f.id, new Map([['Sheet1', s.headers ? [[...s.headers]] : []]]));
        a.writes.push({ method: 'documents.createSpreadsheet', id: f.id });
        return f;
      },
      uploadFile: async (u: UploadInput) => {
        const a = await this.enter(ctx, 'documents', 'uploadFile', [u]);
        const f = a.addFile({ id: newId('created-file'), name: u.name, kind: u.contentType === 'application/pdf' ? 'pdf' : 'other', mimeType: u.contentType, size: u.bytes.length, parentId: u.folderId ?? null });
        a.uploads.set(f.id, u.bytes);
        a.writes.push({ method: 'documents.uploadFile', id: f.id });
        return f;
      },
      createFolder: async (f: NewFolder) => {
        const a = await this.enter(ctx, 'documents', 'createFolder', [f]);
        const folder = a.addFile({ id: newId('created-folder'), name: f.name, kind: 'folder', mimeType: 'application/vnd.google-apps.folder', parentId: f.parentId ?? null });
        a.writes.push({ method: 'documents.createFolder', id: folder.id });
        return folder;
      },
    };
  }
}
