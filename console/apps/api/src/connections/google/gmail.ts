// Gmail behind the neutral MailCapability (E39.3, #601). Plain REST over GoogleHttp; every response is mapped to the neutral
// shapes here, so no Gmail type leaves this file. Permissions (decision record): search, read and labels need `gmail.readonly`,
// send needs `gmail.send`, drafts and modify need `gmail.modify`.
import {
  CapabilityError,
  pageSizeOf,
  type CapabilityContext,
  type DraftRef,
  type FileBytes,
  type MailCapability,
  type MailGetOptions,
  type MailLabel,
  type MailMessage,
  type MailModification,
  type MailQuery,
  type MailSummary,
  type OutgoingMail,
  type Page,
} from '../capabilities';
import { buildGmailQuery } from './gmail-query';
import { GOOGLE } from './google.constants';
import { GoogleHttp, type TokenSource } from './google-http';
import { composeMessage, toRaw } from './mime';
import { decodeBody, decodeEntities, headerValue, htmlToText, parseAddressList } from './mime-parse';

interface GPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name?: string; value?: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GPart[];
}
interface GMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GPart;
}

const SUMMARY_FIELDS = (data: boolean): string => {
  const part = `partId,mimeType,filename,headers,body(attachmentId,size${data ? ',data' : ''})`;
  let nested = part;
  for (let i = 0; i < 5; i++) nested = `${part},parts(${nested})`;
  return `id,threadId,labelIds,snippet,internalDate,payload(${nested})`;
};

const header = (p: GPart | undefined, name: string): string | undefined => p?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value;

function walk(p: GPart | undefined, visit: (p: GPart) => void): void {
  if (!p) return;
  visit(p);
  for (const c of p.parts ?? []) walk(c, visit);
}

const isAttachment = (p: GPart): boolean => !!p.filename && !!p.body?.attachmentId;

function attachmentsOf(p: GPart | undefined): { id: string; filename: string; contentType: string; size: number }[] {
  const out: { id: string; filename: string; contentType: string; size: number }[] = [];
  walk(p, (x) => {
    if (isAttachment(x)) out.push({ id: x.body!.attachmentId!, filename: headerValue(x.filename), contentType: x.mimeType ?? 'application/octet-stream', size: x.body?.size ?? 0 });
  });
  return out;
}

const iso = (ms: string | undefined): string | null => {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
};

function toSummary(m: GMessage): MailSummary {
  const labels = m.labelIds ?? [];
  return {
    id: m.id,
    threadId: m.threadId ?? null,
    from: parseAddressList(header(m.payload, 'From'))[0] ?? null,
    to: parseAddressList(header(m.payload, 'To')),
    subject: headerValue(header(m.payload, 'Subject')),
    snippet: decodeEntities(m.snippet ?? ''),
    date: iso(m.internalDate),
    unread: labels.includes('UNREAD'),
    hasAttachments: attachmentsOf(m.payload).length > 0,
    labels,
  };
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class GoogleMail implements MailCapability {
  constructor(
    private readonly ctx: CapabilityContext,
    private readonly http: GoogleHttp,
    private readonly tokens: TokenSource,
  ) {}

  private api<T>(op: string, path: string, query: Record<string, string | number | boolean | undefined | readonly string[]>, maxBytes?: number) {
    return this.http.call<T>(this.tokens, this.ctx, { service: 'gmail', op, method: 'GET', url: `${GOOGLE.gmail}/${path}`, query, idempotent: true, maxBytes });
  }

  async search(q: MailQuery): Promise<Page<MailSummary>> {
    const { q: query, labelIds } = buildGmailQuery(q);
    const list = await this.api<{ messages?: { id: string }[]; nextPageToken?: string }>('messages.list', 'messages', {
      q: query,
      labelIds,
      maxResults: pageSizeOf(q),
      pageToken: q.pageToken,
      fields: 'messages(id),nextPageToken',
    });
    const ids = (list.data?.messages ?? []).map((m) => m.id);
    const fetched = await Promise.all(
      ids.map(async (id) => {
        try {
          return (await this.api<GMessage>('messages.get', `messages/${encodeURIComponent(id)}`, { format: 'full', fields: SUMMARY_FIELDS(false) })).data;
        } catch (e) {
          if (e instanceof CapabilityError && e.code === 'NOT_FOUND') return null; // deleted between the list and the read
          throw e;
        }
      }),
    );
    return { items: fetched.filter((m): m is GMessage => m !== null).map(toSummary), nextPageToken: list.data?.nextPageToken ?? null };
  }

  async get(id: string, opts: MailGetOptions): Promise<MailMessage> {
    const withBody = opts.body !== 'none';
    const res = await this.api<GMessage>('messages.get', `messages/${encodeURIComponent(id)}`, { format: 'full', fields: SUMMARY_FIELDS(withBody) }, 12 * 1024 * 1024);
    const m = res.data;
    if (!m) throw new CapabilityError('PROVIDER_ERROR', { status: res.status, reason: 'EMPTY' });
    const plain: string[] = [];
    const html: string[] = [];
    if (withBody) {
      walk(m.payload, (p) => {
        if (isAttachment(p) || !p.body?.data) return;
        if (p.mimeType === 'text/plain') plain.push(decodeBody(p.body.data, header(p, 'Content-Type')));
        else if (p.mimeType === 'text/html') html.push(decodeBody(p.body.data, header(p, 'Content-Type')));
      });
    }
    const limit = this.ctx.limits.bodyChars;
    let text: string | null = null;
    let htmlOut: string | null = null;
    if (opts.body === 'text') text = plain.length > 0 ? plain.join('\n') : htmlToText(html.join('\n'));
    if (opts.body === 'html') htmlOut = html.length > 0 ? html.join('\n') : `<pre>${escapeHtml(plain.join('\n'))}</pre>`;
    let truncated = false;
    if (text !== null && text.length > limit) ((text = text.slice(0, limit)), (truncated = true));
    if (htmlOut !== null && htmlOut.length > limit) ((htmlOut = htmlOut.slice(0, limit)), (truncated = true));
    return {
      ...toSummary(m),
      cc: parseAddressList(header(m.payload, 'Cc')),
      replyTo: parseAddressList(header(m.payload, 'Reply-To')),
      internetMessageId: header(m.payload, 'Message-ID') ?? header(m.payload, 'Message-Id') ?? null,
      text,
      html: htmlOut,
      truncated,
      attachments: attachmentsOf(m.payload),
    };
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<FileBytes> {
    const res = await this.api<GMessage>('messages.get', `messages/${encodeURIComponent(messageId)}`, { format: 'full', fields: SUMMARY_FIELDS(false) });
    const part = attachmentsOf(res.data?.payload).find((a) => a.id === attachmentId);
    if (!part) throw new CapabilityError('NOT_FOUND');
    const cap = this.ctx.limits.attachmentBytes;
    if (part.size > cap) throw new CapabilityError('TOO_LARGE', { reason: 'ATTACHMENT_BYTES' });
    const att = await this.api<{ size?: number; data?: string }>('attachments.get', `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, {}, Math.ceil((cap * 4) / 3) + 8192);
    const bytes = Buffer.from(att.data?.data ?? '', 'base64url');
    if (bytes.length > cap) throw new CapabilityError('TOO_LARGE', { reason: 'ATTACHMENT_BYTES' });
    return { filename: part.filename, contentType: part.contentType, size: bytes.length, bytes };
  }

  /** The message as Gmail's `raw`, with the reply headers of the message it answers. */
  private async rawOf(m: OutgoingMail): Promise<{ raw: string; threadId?: string }> {
    let reply: { messageId: string; references: string | null } | undefined;
    let threadId: string | undefined;
    if (m.inReplyTo) {
      const orig = (await this.api<GMessage>('messages.get', `messages/${encodeURIComponent(m.inReplyTo)}`, { format: 'metadata', metadataHeaders: ['Message-ID', 'References'], fields: 'id,threadId,payload(headers)' })).data;
      const messageId = header(orig?.payload, 'Message-ID') ?? header(orig?.payload, 'Message-Id');
      if (messageId) reply = { messageId: messageId.trim(), references: header(orig?.payload, 'References') ?? null };
      threadId = orig?.threadId;
    }
    // From is the connection's own address and nothing else: no alias, no one else's name.
    return { raw: toRaw(composeMessage(m, { from: this.ctx.connection.accountEmail, reply })), threadId };
  }

  async createDraft(m: OutgoingMail): Promise<{ draftId: string }> {
    const { raw, threadId } = await this.rawOf(m);
    const res = await this.http.call<{ id?: string }>(this.tokens, this.ctx, {
      service: 'gmail',
      op: 'drafts.create',
      method: 'POST',
      url: `${GOOGLE.gmail}/drafts`,
      query: { fields: 'id' },
      json: { message: { raw, ...(threadId ? { threadId } : {}) } },
      idempotent: false,
    });
    if (!res.data?.id) throw new CapabilityError('PROVIDER_ERROR', { status: res.status, reason: 'EMPTY' });
    return { draftId: res.data.id };
  }

  async send(m: OutgoingMail | DraftRef): Promise<{ messageId: string }> {
    let res;
    if ('draftId' in m) {
      res = await this.http.call<{ id?: string }>(this.tokens, this.ctx, { service: 'gmail', op: 'drafts.send', method: 'POST', url: `${GOOGLE.gmail}/drafts/send`, query: { fields: 'id' }, json: { id: m.draftId }, idempotent: false });
    } else {
      const { raw, threadId } = await this.rawOf(m);
      res = await this.http.call<{ id?: string }>(this.tokens, this.ctx, {
        service: 'gmail',
        op: 'messages.send',
        method: 'POST',
        url: `${GOOGLE.gmail}/messages/send`,
        query: { fields: 'id' },
        json: { raw, ...(threadId ? { threadId } : {}) },
        idempotent: false,
        timeoutMs: 60_000,
      });
    }
    if (!res.data?.id) throw new CapabilityError('PROVIDER_ERROR', { status: res.status, reason: 'EMPTY', outcomeUnknown: true });
    return { messageId: res.data.id };
  }

  async modify(id: string, change: MailModification): Promise<void> {
    const add = new Set(change.addLabels ?? []);
    const remove = new Set(change.removeLabels ?? []);
    if (change.read === true) remove.add('UNREAD');
    if (change.read === false) add.add('UNREAD');
    if (change.archive === true) remove.add('INBOX');
    for (const l of add) remove.delete(l);
    if (add.size === 0 && remove.size === 0) return;
    await this.http.call(this.tokens, this.ctx, {
      service: 'gmail',
      op: 'messages.modify',
      method: 'POST',
      url: `${GOOGLE.gmail}/messages/${encodeURIComponent(id)}/modify`,
      query: { fields: 'id' },
      json: { addLabelIds: [...add], removeLabelIds: [...remove] },
      idempotent: true,
    });
  }

  async listLabels(): Promise<MailLabel[]> {
    const res = await this.api<{ labels?: { id: string; name: string; type?: string }[] }>('labels.list', 'labels', { fields: 'labels(id,name,type)' });
    return (res.data?.labels ?? []).map((l) => ({ id: l.id, name: l.name, kind: l.type === 'user' ? ('user' as const) : ('system' as const) }));
  }
}
