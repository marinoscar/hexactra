// Outlook mail through Microsoft Graph (E39.4, #602): the `MailCapability` for a Microsoft account. Differences from Gmail are in
// the capability matrix (capability-matrix.ts) and docs/connections.md, "Microsoft": folders and categories instead of labels, a
// search that cannot be combined with filters, and sends that are not idempotent.
//
//   search   `$filter` for structured queries, `$search` (KQL) when there is free text, a subject or a name to look for. The two cannot
//            be combined at Graph, so in search mode the remaining filters (dates, unread, attachment, category) are applied to each
//            page: a page can be short, the next page token is always right. Every value is escaped: an OData string literal doubles
//            its quotes, a KQL phrase is quoted and its quotes and backslashes escaped, so `" OR from:x` stays text.
//   get      the text body is asked for with `Prefer: outlook.body-content-type="text"`.
//   send     with the modify switch on: a draft is created, then sent (so a retry after an ambiguous failure can check whether the draft
//            is gone); with send-only permission: `/me/sendMail`, which gives no message id and cannot be retried blindly. A caller's
//            `idempotencyKey` is remembered for ten minutes so a repeated call does not send twice (in this process: see the docs).
import { randomUUID } from 'node:crypto';

import {
  CapabilityError,
  mailAddress,
  pageSizeOf,
  type CapabilityContext,
  type DraftRef,
  type FileBytes,
  type MailAddress,
  type MailCapability,
  type MailGetOptions,
  type MailLabel,
  type MailMessage,
  type MailModification,
  type MailQuery,
  type MailSummary,
  type OutgoingAttachment,
  type OutgoingMail,
  type Page,
} from '../capabilities';
import { senderAuthFrom } from '../mail-auth';
import { GraphClient, decodePageToken, encodePageToken } from './graph-client';
import { INLINE_ATTACHMENT_BYTES, MAIL_FIELDS, MESSAGE_FIELDS, UPLOAD_CHUNK_BYTES } from './microsoft.constants';
import { isoZ, odataString, seg } from './microsoft.support';

type G = Record<string, unknown>;

const WELL_KNOWN = ['inbox', 'archive', 'drafts', 'sentitems', 'deleteditems', 'junkemail'] as const;
const WELL_KNOWN_NAME: Record<(typeof WELL_KNOWN)[number], string> = { inbox: 'Inbox', archive: 'Archive', drafts: 'Drafts', sentitems: 'Sent Items', deleteditems: 'Deleted Items', junkemail: 'Junk Email' };
/**
 * The well-known folders carry the neutral system label ids every provider shares (the interface's "a system label such as `INBOX`"):
 * callers such as the mail trigger say `INBOX` without knowing the provider. `folder:inbox` (the alias) is accepted as well.
 */
const SYSTEM_ID: Record<(typeof WELL_KNOWN)[number], string> = { inbox: 'INBOX', archive: 'ARCHIVE', drafts: 'DRAFT', sentitems: 'SENT', deleteditems: 'TRASH', junkemail: 'SPAM' };
const ALIAS_OF_SYSTEM = new Map(Object.entries(SYSTEM_ID).map(([alias, id]) => [id, alias]));
const FOLDER_TTL_MS = 10 * 60_000;
const DEDUPE_TTL_MS = 10 * 60_000;
const DEDUPE_MAX = 5_000;
const ID_PREFER = 'IdType="ImmutableId"';

// ---- escaping ----

/** A KQL phrase: quoted, with backslash and quote escaped; control characters dropped. Operators inside it are plain text. */
// eslint-disable-next-line no-control-regex
export const kqlPhrase = (v: string): string => `"${v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The `$search` parameter: the whole KQL expression in quotes, escaped once more for that outer pair of quotes. */
export const searchParam = (kql: string): string => `"${kql.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const addressLike = (v: string | undefined): v is string => !!v && /^[^@\s"'\\]+@[^@\s"'\\]+$/.test(v.trim());

// ---- labels ----

export type ParsedLabel = { kind: 'folder'; id: string } | { kind: 'category'; name: string };
export function parseLabel(label: string): ParsedLabel | null {
  const alias = ALIAS_OF_SYSTEM.get(label.toUpperCase());
  if (alias) return { kind: 'folder', id: alias };
  if (label.startsWith('folder:') && label.length > 7) return { kind: 'folder', id: label.slice(7) };
  if (label.startsWith('category:') && label.length > 9) return { kind: 'category', name: label.slice(9) };
  return null;
}

// ---- the folders of one account, cached ----

interface FolderMap {
  at: number;
  /** alias to the folder's id. */
  idOf: Map<string, string>;
  aliasOf: Map<string, string>;
}

// ---- sends that must not happen twice ----

type SendRecord = { state: 'pending' } | { state: 'draft'; draftId: string } | { state: 'sent'; messageId: string } | { state: 'ambiguous' };

/** A short-lived memory of sends by idempotency key (ten minutes, per process). The key is only ever a hash input here, never logged. */
export class SendDedupe {
  private readonly map = new Map<string, { at: number; rec: SendRecord }>();
  constructor(private readonly now: () => number = Date.now) {}

  get(key: string): SendRecord | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (this.now() - e.at > DEDUPE_TTL_MS) {
      this.map.delete(key);
      return undefined;
    }
    return e.rec;
  }

  set(key: string, rec: SendRecord): void {
    if (this.map.size >= DEDUPE_MAX) for (const k of this.map.keys()) { this.map.delete(k); if (this.map.size < DEDUPE_MAX / 2) break; }
    this.map.set(key, { at: this.now(), rec });
  }

  delete(key: string): void {
    this.map.delete(key);
  }
}

export class MicrosoftFolders {
  private readonly cache = new Map<string, FolderMap>();
  constructor(private readonly now: () => number = Date.now) {}

  async load(g: GraphClient, ctx: CapabilityContext): Promise<FolderMap> {
    const hit = this.cache.get(ctx.connectionId);
    if (hit && this.now() - hit.at < FOLDER_TTL_MS) return hit;
    const idOf = new Map<string, string>();
    const aliasOf = new Map<string, string>();
    for (const alias of WELL_KNOWN) {
      const r = (await g.request(ctx, { op: 'mail.folder', method: 'GET', path: `/me/mailFolders/${alias}`, query: { $select: 'id' }, accept: 'json', okStatuses: [404], capability: 'mail_read' })).json as G | null;
      if (typeof r?.id === 'string') {
        idOf.set(alias, r.id);
        aliasOf.set(r.id, alias);
      }
    }
    const map = { at: this.now(), idOf, aliasOf };
    this.cache.set(ctx.connectionId, map);
    return map;
  }
}

// ---- sender authentication (E39.8: the mail trigger refuses a `fail`) ----

/** Microsoft's own servers: the authserv-id of the header Exchange Online (or Outlook.com) stamps. */
const MICROSOFT_AUTHSERV = /(^|\.)(protection\.outlook\.com|outlook\.com|hotmail\.com|live\.com|office365\.com|exchangelabs\.com)$/;
/** Exchange Online often writes the header with no authserv-id at all (`spf=pass ...; dkim=pass ...`); it is given this stand-in name so it can be read and trusted as Microsoft's. */
const EOP_STAND_IN = 'eop.protection.outlook.com';

/**
 * Every `Authentication-Results` header of the message, top to bottom (`internetMessageHeaders`). Microsoft prepends its own when it
 * receives the message, so only the topmost counts, and only when Microsoft's own server wrote it: a header the sender wrote sits
 * below it and one with another server's name is ignored. (Limit: a header with no server name is read as Microsoft's, because that is
 * how Exchange Online writes its own; Microsoft stamps every message it receives, so a sender's copy is always below it.)
 */
export function authResultsOf(headers: unknown): string[] {
  if (!Array.isArray(headers)) return [];
  return (headers as { name?: unknown; value?: unknown }[])
    .filter((h) => typeof h?.name === 'string' && h.name.toLowerCase() === 'authentication-results' && typeof h.value === 'string')
    .map((h) => {
      const v = (h.value as string).trim();
      return /^[a-z][a-z0-9-]*\s*=/i.test(v) ? `${EOP_STAND_IN}; ${v}` : v;
    });
}
export const isMicrosoftServer = (id: string): boolean => MICROSOFT_AUTHSERV.test(id.toLowerCase());

// ---- mapping ----

const asAddress = (r: unknown): MailAddress | null => {
  const e = (r as { emailAddress?: { address?: unknown; name?: unknown } } | null)?.emailAddress;
  const parsed = mailAddress.safeParse({ address: typeof e?.address === 'string' ? e.address : '', name: typeof e?.name === 'string' && e.name ? e.name : null });
  return parsed.success ? parsed.data : null;
};
const asAddresses = (v: unknown): MailAddress[] => (Array.isArray(v) ? v.map(asAddress).filter((a): a is MailAddress => a !== null) : []);
const recipient = (a: MailAddress) => ({ emailAddress: { address: a.address, ...(a.name ? { name: a.name } : {}) } });
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export class MicrosoftMail implements MailCapability {
  constructor(
    private readonly g: GraphClient,
    private readonly ctx: CapabilityContext,
    private readonly shared: { folders: MicrosoftFolders; dedupe: SendDedupe },
  ) {}

  private labelsOf(m: G, folders: FolderMap): string[] {
    const folderId = str(m.parentFolderId);
    const alias = folders.aliasOf.get(folderId);
    const cats = Array.isArray(m.categories) ? m.categories.filter((c): c is string => typeof c === 'string').map((c) => `category:${c}`) : [];
    return [...(folderId ? [alias ? SYSTEM_ID[alias as keyof typeof SYSTEM_ID] : `folder:${folderId}`] : []), ...cats];
  }

  private summary(m: G, folders: FolderMap): MailSummary {
    const from = asAddress(m.from);
    const received = typeof m.receivedDateTime === 'string' && Number.isFinite(Date.parse(m.receivedDateTime)) ? new Date(m.receivedDateTime).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
    return {
      id: str(m.id),
      threadId: typeof m.conversationId === 'string' ? m.conversationId : null,
      from,
      // The receiving server's own SPF, DKIM and DMARC result for the From address: the mail trigger refuses a `fail`.
      senderAuth: senderAuthFrom(authResultsOf(m.internetMessageHeaders), from?.address, { trusted: isMicrosoftServer }),
      to: asAddresses(m.toRecipients),
      subject: str(m.subject),
      snippet: str(m.bodyPreview),
      date: received,
      unread: m.isRead === false,
      hasAttachments: m.hasAttachments === true,
      labels: this.labelsOf(m, folders),
    };
  }

  // ---- search ----

  async search(q: MailQuery): Promise<Page<MailSummary>> {
    const size = pageSizeOf(q);
    const label = q.label ? parseLabel(q.label) : null;
    if (q.label && !label) throw new CapabilityError('INVALID_INPUT', { issues: ['label'] });
    const base = label?.kind === 'folder' ? `/me/mailFolders/${seg(label.id)}/messages` : '/me/messages';
    const searching = !!q.text?.trim() || !!q.subject?.trim() || (!!q.from && !addressLike(q.from)) || (!!q.to && !addressLike(q.to));

    let req: { path: string; query?: Record<string, string> };
    if (q.pageToken) {
      req = { path: decodePageToken(q.pageToken, `${base}?`) };
    } else if (searching) {
      const kql: string[] = [];
      if (q.text?.trim()) kql.push(kqlPhrase(q.text.trim()));
      if (q.subject?.trim()) kql.push(`subject:${kqlPhrase(q.subject.trim())}`);
      if (q.from?.trim()) kql.push(`from:${kqlPhrase(q.from.trim())}`);
      if (q.to?.trim()) kql.push(`to:${kqlPhrase(q.to.trim())}`);
      req = { path: base, query: { $search: searchParam(kql.join(' AND ')), $top: String(size), $select: MAIL_FIELDS } };
    } else {
      const f = [`receivedDateTime ge ${q.after ? isoZ(q.after) : '1970-01-01T00:00:00Z'}`];
      if (q.before) f.push(`receivedDateTime lt ${isoZ(q.before)}`);
      if (q.from) f.push(`from/emailAddress/address eq '${odataString(q.from.trim())}'`);
      if (q.to) f.push(`toRecipients/any(r:r/emailAddress/address eq '${odataString(q.to.trim())}')`);
      if (q.unread !== undefined) f.push(`isRead eq ${q.unread ? 'false' : 'true'}`);
      if (q.hasAttachment !== undefined) f.push(`hasAttachments eq ${q.hasAttachment ? 'true' : 'false'}`);
      if (label?.kind === 'category') f.push(`categories/any(c:c eq '${odataString(label.name)}')`);
      req = { path: base, query: { $filter: f.join(' and '), $orderby: 'receivedDateTime desc', $top: String(size), $select: MAIL_FIELDS } };
    }

    const res = (await this.g.json<G>(this.ctx, { op: 'mail.search', method: 'GET', ...req, headers: { Prefer: ID_PREFER }, capability: 'mail_read' })) ?? {};
    const folders = await this.shared.folders.load(this.g, this.ctx);
    let rows = (Array.isArray(res.value) ? res.value : []) as G[];
    // Search mode cannot carry the other filters to Graph: the rest are applied to this page.
    if (searching || q.pageToken) rows = rows.filter((m) => this.matches(m, q, label));
    return { items: rows.slice(0, size).map((m) => this.summary(m, folders)), nextPageToken: encodePageToken(res['@odata.nextLink'], this.g.baseUrl) };
  }

  private matches(m: G, q: MailQuery, label: ParsedLabel | null): boolean {
    const t = typeof m.receivedDateTime === 'string' ? Date.parse(m.receivedDateTime) : NaN;
    if (q.after && !(t >= Date.parse(q.after))) return false;
    if (q.before && !(t < Date.parse(q.before))) return false;
    if (q.unread !== undefined && (m.isRead === false) !== q.unread) return false;
    if (q.hasAttachment !== undefined && (m.hasAttachments === true) !== q.hasAttachment) return false;
    if (label?.kind === 'category' && !(Array.isArray(m.categories) && m.categories.includes(label.name))) return false;
    return true;
  }

  // ---- reading ----

  async get(id: string, opts: MailGetOptions): Promise<MailMessage> {
    const m = (await this.g.json<G>(this.ctx, {
      op: 'mail.get',
      method: 'GET',
      path: `/me/messages/${seg(id)}`,
      query: { $select: opts.body === 'none' ? `${MAIL_FIELDS},ccRecipients,replyTo,internetMessageId` : MESSAGE_FIELDS },
      headers: { Prefer: `outlook.body-content-type="${opts.body === 'html' ? 'html' : 'text'}", ${ID_PREFER}` },
      capability: 'mail_read',
    })) as G;
    const folders = await this.shared.folders.load(this.g, this.ctx);
    const bodyContent = str((m.body as G | undefined)?.content);
    const limit = this.ctx.limits.bodyChars;
    const cut = opts.body !== 'none' && bodyContent.length > limit;
    const content = opts.body === 'none' ? null : cut ? bodyContent.slice(0, limit) : bodyContent;
    let attachments: MailMessage['attachments'] = [];
    if (m.hasAttachments === true) {
      const list = (await this.g.json<G>(this.ctx, { op: 'mail.attachments', method: 'GET', path: `/me/messages/${seg(id)}/attachments`, query: { $select: 'id,name,contentType,size', $top: '50' }, capability: 'mail_read' })) ?? {};
      attachments = ((Array.isArray(list.value) ? list.value : []) as G[]).map((a) => ({ id: str(a.id), filename: str(a.name), contentType: str(a.contentType) || 'application/octet-stream', size: typeof a.size === 'number' && a.size >= 0 ? Math.floor(a.size) : 0 }));
    }
    return {
      ...this.summary(m, folders),
      cc: asAddresses(m.ccRecipients),
      replyTo: asAddresses(m.replyTo),
      internetMessageId: typeof m.internetMessageId === 'string' ? m.internetMessageId : null,
      text: opts.body === 'text' ? content : null,
      html: opts.body === 'html' ? content : null,
      truncated: cut,
      attachments,
    };
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<FileBytes> {
    const path = `/me/messages/${seg(messageId)}/attachments/${seg(attachmentId)}`;
    const meta = (await this.g.json<G>(this.ctx, { op: 'mail.attachment_info', method: 'GET', path, query: { $select: 'id,name,contentType,size' }, capability: 'mail_read' })) as G;
    if (meta['@odata.type'] !== '#microsoft.graph.fileAttachment') throw new CapabilityError('NOT_SUPPORTED', { reason: 'ATTACHMENT_KIND' });
    if (typeof meta.size === 'number' && meta.size > this.ctx.limits.attachmentBytes) throw new CapabilityError('TOO_LARGE', { reason: 'ATTACHMENT_BYTES' });
    const res = await this.g.request(this.ctx, { op: 'mail.attachment', method: 'GET', path: `${path}/$value`, accept: 'buffer', capability: 'mail_read' });
    const bytes = res.buffer ?? Buffer.alloc(0);
    return { filename: str(meta.name), contentType: str(meta.contentType) || 'application/octet-stream', size: bytes.length, bytes };
  }

  // ---- writing ----

  private message(m: OutgoingMail): Record<string, unknown> {
    return {
      subject: m.subject,
      body: m.html !== undefined ? { contentType: 'html', content: m.html } : { contentType: 'text', content: m.text ?? '' },
      toRecipients: m.to.map(recipient),
      ...(m.cc?.length ? { ccRecipients: m.cc.map(recipient) } : {}),
      ...(m.bcc?.length ? { bccRecipients: m.bcc.map(recipient) } : {}),
    };
  }

  private fileAttachment = (a: OutgoingAttachment) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.filename, contentType: a.contentType, contentBytes: a.bytes.toString('base64') });

  async createDraft(m: OutgoingMail): Promise<{ draftId: string }> {
    return { draftId: await this.makeDraft(m) };
  }

  private async makeDraft(m: OutgoingMail): Promise<string> {
    const inline = (m.attachments ?? []).filter((a) => a.bytes.length <= INLINE_ATTACHMENT_BYTES);
    const total = inline.reduce((n, a) => n + a.bytes.length, 0);
    const sendInline = !m.inReplyTo && total <= INLINE_ATTACHMENT_BYTES;
    let draft: G;
    if (m.inReplyTo) {
      const created = (await this.g.json<G>(this.ctx, { op: 'mail.create_reply', method: 'POST', path: `/me/messages/${seg(m.inReplyTo)}/createReply`, json: {}, headers: { Prefer: ID_PREFER }, capability: 'mail_modify' })) as G;
      draft = (await this.g.json<G>(this.ctx, { op: 'mail.update_draft', method: 'PATCH', path: `/me/messages/${seg(str(created.id))}`, json: this.message(m), repeatable: true, capability: 'mail_modify' })) as G;
    } else {
      draft = (await this.g.json<G>(this.ctx, { op: 'mail.create_draft', method: 'POST', path: '/me/messages', json: { ...this.message(m), ...(sendInline && inline.length ? { attachments: inline.map(this.fileAttachment) } : {}) }, headers: { Prefer: ID_PREFER, 'client-request-id': randomUUID() }, capability: 'mail_modify' })) as G;
    }
    const draftId = str(draft.id);
    if (!draftId) throw new CapabilityError('PROVIDER_ERROR', { status: 502, reason: 'BAD_RESPONSE' });
    const rest = (m.attachments ?? []).filter((a) => !(sendInline && a.bytes.length <= INLINE_ATTACHMENT_BYTES));
    for (const a of rest) await this.attach(draftId, a);
    return draftId;
  }

  private async attach(draftId: string, a: OutgoingAttachment): Promise<void> {
    const base = `/me/messages/${seg(draftId)}/attachments`;
    if (a.bytes.length <= INLINE_ATTACHMENT_BYTES) {
      await this.g.request(this.ctx, { op: 'mail.attach', method: 'POST', path: base, json: this.fileAttachment(a), accept: 'none', capability: 'mail_modify' });
      return;
    }
    const session = (await this.g.json<G>(this.ctx, { op: 'mail.attach_session', method: 'POST', path: `${base}/createUploadSession`, json: { AttachmentItem: { attachmentType: 'file', name: a.filename, size: a.bytes.length, contentType: a.contentType } }, capability: 'mail_modify' })) as G;
    const uploadUrl = str(session.uploadUrl);
    if (!uploadUrl.startsWith('https://')) throw new CapabilityError('PROVIDER_ERROR', { status: 502, reason: 'BAD_RESPONSE' });
    for (let at = 0; at < a.bytes.length; at += UPLOAD_CHUNK_BYTES) {
      const chunk = a.bytes.subarray(at, Math.min(a.bytes.length, at + UPLOAD_CHUNK_BYTES));
      await this.g.request(this.ctx, {
        op: 'mail.attach_chunk',
        method: 'PUT',
        path: '',
        absoluteUrl: uploadUrl,
        body: chunk,
        headers: { 'content-range': `bytes ${at}-${at + chunk.length - 1}/${a.bytes.length}` },
        accept: 'none',
        repeatable: true,
      });
    }
  }

  async send(m: OutgoingMail | DraftRef): Promise<{ messageId: string }> {
    if ('draftId' in m && !('to' in m)) return this.sendDraft(m.draftId);
    const mail = m as OutgoingMail;
    const key = mail.idempotencyKey ? `${this.ctx.connectionId}:${mail.idempotencyKey}` : null;
    const dedupe = this.shared.dedupe;
    if (key) {
      const seen = dedupe.get(key);
      if (seen?.state === 'sent') return { messageId: seen.messageId };
      if (seen?.state === 'pending') throw new CapabilityError('CONFLICT', { reason: 'IN_FLIGHT' });
      if (seen?.state === 'ambiguous') throw new CapabilityError('CONFLICT', { reason: 'SEND_AMBIGUOUS' });
      // A retry of a draft whose send was left unknown: a draft that is gone was sent (this code made it, nobody else is known to delete it).
      if (seen?.state === 'draft') return this.finishSend(key, seen.draftId, true);
      dedupe.set(key, { state: 'pending' });
    }
    try {
      let draftId: string | null = null;
      if (this.ctx.connection.capabilities.includes('mail_modify')) {
        try {
          draftId = await this.makeDraft(mail);
        } catch (e) {
          // The switch is on but the grant is not: fall back to the send-only path instead of failing a send that could work.
          if (!(e instanceof CapabilityError && e.code === 'PERMISSION_MISSING')) throw e;
        }
      }
      if (draftId) {
        if (key) dedupe.set(key, { state: 'draft', draftId });
        return await this.finishSend(key, draftId);
      }
      return await this.sendMail(mail, key);
    } catch (e) {
      if (key && dedupe.get(key)?.state === 'pending') dedupe.delete(key);
      throw e;
    }
  }

  private async finishSend(key: string | null, draftId: string, goneMeansSent = false): Promise<{ messageId: string }> {
    try {
      const r = await this.sendDraft(draftId).catch((e: unknown) => {
        if (goneMeansSent && e instanceof CapabilityError && e.code === 'NOT_FOUND') return { messageId: draftId };
        throw e;
      });
      if (key) this.shared.dedupe.set(key, { state: 'sent', messageId: r.messageId });
      return r;
    } catch (e) {
      const ambiguous = e instanceof CapabilityError && e.details.outcomeUnknown === true;
      if (key && !ambiguous) this.shared.dedupe.delete(key);
      if (!ambiguous) await this.g.request(this.ctx, { op: 'mail.discard_draft', method: 'DELETE', path: `/me/messages/${seg(draftId)}`, accept: 'none', okStatuses: [404] }).catch(() => undefined);
      throw e;
    }
  }

  /** Sends a saved draft. After a failure that leaves it unknown, the draft is looked at before anything is sent again. */
  private async sendDraft(draftId: string): Promise<{ messageId: string }> {
    const path = `/me/messages/${seg(draftId)}`;
    const send = () => this.g.request(this.ctx, { op: 'mail.send_draft', method: 'POST', path: `${path}/send`, accept: 'none', headers: { 'client-request-id': randomUUID() }, capability: 'mail_send' });
    try {
      await send();
      return { messageId: draftId };
    } catch (e) {
      if (!(e instanceof CapabilityError && e.details.outcomeUnknown === true)) throw e;
      const now = await this.g.request(this.ctx, { op: 'mail.check_draft', method: 'GET', path, query: { $select: 'id,isDraft' }, accept: 'json', okStatuses: [404], capability: 'mail_read' }).catch(() => null);
      if (!now) throw e;
      const still = now.status === 200 && (now.json as G | null)?.isDraft === true;
      if (!still) return { messageId: draftId };
      await send();
      return { messageId: draftId };
    }
  }

  /** The send-only path: no draft, so no verification and no id; a failure that leaves it unknown is never retried. */
  private async sendMail(m: OutgoingMail, key: string | null): Promise<{ messageId: string }> {
    const atts = m.attachments ?? [];
    if (atts.some((a) => a.bytes.length > INLINE_ATTACHMENT_BYTES) || atts.reduce((n, a) => n + a.bytes.length, 0) > INLINE_ATTACHMENT_BYTES) throw new CapabilityError('TOO_LARGE', { reason: 'SEND_ONLY_ATTACHMENTS' });
    const message: Record<string, unknown> = { ...this.message(m), ...(atts.length ? { attachments: atts.map(this.fileAttachment) } : {}) };
    try {
      if (m.inReplyTo) await this.g.request(this.ctx, { op: 'mail.reply', method: 'POST', path: `/me/messages/${seg(m.inReplyTo)}/reply`, json: { message: { toRecipients: message.toRecipients, ccRecipients: message.ccRecipients, bccRecipients: message.bccRecipients, body: message.body, attachments: message.attachments } }, accept: 'none', headers: { 'client-request-id': randomUUID() }, capability: 'mail_send' });
      else await this.g.request(this.ctx, { op: 'mail.send_mail', method: 'POST', path: '/me/sendMail', json: { message, saveToSentItems: true }, accept: 'none', headers: { 'client-request-id': randomUUID() }, capability: 'mail_send' });
    } catch (e) {
      if (key && e instanceof CapabilityError && e.details.outcomeUnknown === true) this.shared.dedupe.set(key, { state: 'ambiguous' });
      throw e;
    }
    const messageId = `sendmail:${randomUUID()}`;
    if (key) this.shared.dedupe.set(key, { state: 'sent', messageId });
    return { messageId };
  }

  // ---- changing ----

  async modify(id: string, change: MailModification): Promise<void> {
    const path = `/me/messages/${seg(id)}`;
    const add = (change.addLabels ?? []).map((l) => ({ l, p: parseLabel(l) }));
    const remove = (change.removeLabels ?? []).map((l) => ({ l, p: parseLabel(l) }));
    if (add.some((x) => !x.p)) throw new CapabilityError('INVALID_INPUT', { issues: ['addLabels'] });
    if (remove.some((x) => !x.p)) throw new CapabilityError('INVALID_INPUT', { issues: ['removeLabels'] });
    const addFolders = add.map((x) => x.p!).filter((p): p is { kind: 'folder'; id: string } => p.kind === 'folder');
    const removeFolders = remove.map((x) => x.p!).filter((p): p is { kind: 'folder'; id: string } => p.kind === 'folder');
    const addCats = add.map((x) => x.p!).filter((p): p is { kind: 'category'; name: string } => p.kind === 'category').map((p) => p.name);
    const removeCats = remove.map((x) => x.p!).filter((p): p is { kind: 'category'; name: string } => p.kind === 'category').map((p) => p.name);
    // A message is in one folder: more than one destination, or a folder to leave other than the inbox, cannot be expressed.
    if (addFolders.length > 1 || (change.archive === true && addFolders.length > 0)) throw new CapabilityError('INVALID_INPUT', { issues: ['addLabels'] });
    if (removeFolders.some((f) => f.id !== 'inbox')) throw new CapabilityError('INVALID_INPUT', { issues: ['removeLabels'] });

    const patch: Record<string, unknown> = {};
    if (change.read !== undefined) patch.isRead = change.read;
    if (addCats.length > 0 || removeCats.length > 0) {
      const cur = (await this.g.json<G>(this.ctx, { op: 'mail.categories', method: 'GET', path, query: { $select: 'categories' }, capability: 'mail_modify' })) as G;
      const have = new Set(Array.isArray(cur.categories) ? (cur.categories as unknown[]).filter((c): c is string => typeof c === 'string') : []);
      for (const c of removeCats) have.delete(c);
      for (const c of addCats) have.add(c);
      patch.categories = [...have];
    }
    if (Object.keys(patch).length > 0) await this.g.request(this.ctx, { op: 'mail.modify', method: 'PATCH', path, json: patch, accept: 'none', repeatable: true, headers: { Prefer: ID_PREFER }, capability: 'mail_modify' });

    const destination = addFolders[0]?.id ?? (change.archive === true ? 'archive' : change.archive === false ? 'inbox' : removeFolders.length > 0 ? 'archive' : null);
    if (destination) await this.g.request(this.ctx, { op: 'mail.move', method: 'POST', path: `${path}/move`, json: { destinationId: destination }, accept: 'none', repeatable: true, headers: { Prefer: ID_PREFER }, capability: 'mail_modify' });
  }

  async listLabels(): Promise<MailLabel[]> {
    const folders = await this.shared.folders.load(this.g, this.ctx);
    const out: MailLabel[] = WELL_KNOWN.filter((a) => folders.idOf.has(a)).map((a) => ({ id: SYSTEM_ID[a], name: WELL_KNOWN_NAME[a], kind: 'system' as const }));
    const list = (await this.g.json<G>(this.ctx, { op: 'mail.folders', method: 'GET', path: '/me/mailFolders', query: { $top: '100', $select: 'id,displayName' }, capability: 'mail_read' })) ?? {};
    for (const f of (Array.isArray(list.value) ? list.value : []) as G[]) if (str(f.id) && !folders.aliasOf.has(str(f.id))) out.push({ id: `folder:${str(f.id)}`, name: str(f.displayName), kind: 'user' });
    const cats = await this.g.request(this.ctx, { op: 'mail.categories_list', method: 'GET', path: '/me/outlook/masterCategories', accept: 'json', okStatuses: [404], capability: 'mail_read' });
    for (const c of (Array.isArray((cats.json as G | null)?.value) ? ((cats.json as G).value as G[]) : []) as G[]) if (str(c.displayName)) out.push({ id: `category:${str(c.displayName)}`, name: str(c.displayName), kind: 'user' });
    return out;
  }
}
