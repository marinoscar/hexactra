// The Graph routes of the fake (fake-graph.ts): mail, calendar, OneDrive and the Excel workbook API for one signed-in account.
import { randomUUID } from 'node:crypto';

import { FAKE_HOSTS, FakeGraph, driveItemJson, err, respond, wallToUtc, type FakeAccount, type FakeDriveItem, type FakeEvent, type FakeMessage, type FakeSheet, type Recorded } from './fake-graph';

type G = Record<string, unknown>;

class BadRequest extends Error {}

const GRAPH_ORIGIN = `https://${FAKE_HOSTS.graph}`;
const DEFAULT_TOP = 10;

// ---- OData and KQL, parsed for real so a malformed or unescaped value fails here ----

function splitAnd(filter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < filter.length; i++) {
    const ch = filter[i]!;
    if (ch === "'") inQuote = !inQuote;
    if (!inQuote && filter.startsWith(' and ', i)) {
      out.push(cur);
      cur = '';
      i += 4;
      continue;
    }
    cur += ch;
  }
  if (inQuote) throw new BadRequest('unterminated string');
  out.push(cur);
  return out;
}

const lit = (s: string): string => s.replace(/''/g, "'");
const LITERAL = "'((?:[^']|'')*)'";

function filterMessage(filter: string, m: FakeMessage): boolean {
  for (const clause of splitAnd(filter)) {
    let x: RegExpExecArray | null;
    if ((x = /^receivedDateTime (ge|lt) (\S+)$/.exec(clause))) {
      const t = Date.parse(m.receivedDateTime);
      const v = Date.parse(x[2]!);
      if (!Number.isFinite(v)) throw new BadRequest('bad date');
      if (x[1] === 'ge' ? !(t >= v) : !(t < v)) return false;
    } else if ((x = new RegExp(`^from/emailAddress/address eq ${LITERAL}$`).exec(clause))) {
      if (m.from?.address.toLowerCase() !== lit(x[1]!).toLowerCase()) return false;
    } else if ((x = new RegExp(`^toRecipients/any\\(r:r/emailAddress/address eq ${LITERAL}\\)$`).exec(clause))) {
      if (!m.to.some((r) => r.address.toLowerCase() === lit(x![1]!).toLowerCase())) return false;
    } else if ((x = /^isRead eq (true|false)$/.exec(clause))) {
      if (m.isRead !== (x[1] === 'true')) return false;
    } else if ((x = /^hasAttachments eq (true|false)$/.exec(clause))) {
      if ((m.attachments.length > 0) !== (x[1] === 'true')) return false;
    } else if ((x = new RegExp(`^categories/any\\(c:c eq ${LITERAL}\\)$`).exec(clause))) {
      if (!m.categories.includes(lit(x[1]!))) return false;
    } else throw new BadRequest('unsupported filter');
  }
  return true;
}

/** `$search="<kql>"`: the outer quotes and escapes first, then the KQL terms `[field:]"phrase"` joined by ` AND `, nothing else allowed. */
function parseSearch(param: string): { field: string | null; phrase: string }[] {
  if (!/^".*"$/s.test(param)) throw new BadRequest('search must be quoted');
  const kql = param.slice(1, -1).replace(/\\(["\\])/g, '$1');
  const terms: { field: string | null; phrase: string }[] = [];
  const re = /(?:(subject|from|to):)?"((?:[^"\\]|\\.)*)"/y;
  let at = 0;
  for (;;) {
    re.lastIndex = at;
    const t = re.exec(kql);
    if (!t) throw new BadRequest('bad kql');
    terms.push({ field: t[1] ?? null, phrase: t[2]!.replace(/\\(["\\])/g, '$1') });
    at = re.lastIndex;
    if (at === kql.length) break;
    if (!kql.startsWith(' AND ', at)) throw new BadRequest('bad kql');
    at += 5;
  }
  return terms;
}

const has = (hay: string, needle: string): boolean => hay.toLowerCase().includes(needle.toLowerCase());
function searchMessage(terms: { field: string | null; phrase: string }[], m: FakeMessage): boolean {
  return terms.every(({ field, phrase }) => {
    const people = (a: { address: string; name?: string }[]) => a.some((p) => has(`${p.address} ${p.name ?? ''}`, phrase));
    if (field === 'subject') return has(m.subject, phrase);
    if (field === 'from') return !!m.from && has(`${m.from.address} ${m.from.name ?? ''}`, phrase);
    if (field === 'to') return people(m.to);
    return has(m.subject, phrase) || has(m.text, phrase) || (!!m.html && has(m.html, phrase)) || (!!m.from && has(m.from.address, phrase));
  });
}

const stripTags = (h: string): string => h.replace(/<[^>]*>/g, '');
const preview = (m: FakeMessage): string => m.text.slice(0, 255);
const addr = (a: { address: string; name?: string }) => ({ emailAddress: { address: a.address, ...(a.name ? { name: a.name } : {}) } });
const fromGraph = (r: unknown): { address: string; name?: string }[] => (Array.isArray(r) ? r : []).map((x: G) => ({ address: String((x.emailAddress as G).address), ...(typeof (x.emailAddress as G).name === 'string' ? { name: (x.emailAddress as G).name as string } : {}) }));

function messageJson(m: FakeMessage, prefer: string, select: string | undefined): G {
  const wantText = /outlook\.body-content-type="text"/.test(prefer);
  const body = wantText ? { contentType: 'text', content: m.html ? stripTags(m.html) : m.text } : { contentType: 'html', content: m.html ?? `<p>${m.text}</p>` };
  const all: G = {
    id: m.id,
    conversationId: m.conversationId,
    parentFolderId: m.folderId,
    from: m.from ? addr(m.from) : null,
    toRecipients: m.to.map(addr),
    ccRecipients: m.cc.map(addr),
    replyTo: [],
    subject: m.subject,
    bodyPreview: preview(m),
    body,
    receivedDateTime: m.receivedDateTime,
    isRead: m.isRead,
    hasAttachments: m.attachments.length > 0,
    categories: m.categories,
    isDraft: m.isDraft,
    internetMessageId: m.internetMessageId,
    // Graph answers the headers only when asked for them with $select.
    internetMessageHeaders: m.authenticationResults ? [{ name: 'Received', value: 'from mail.example.test' }, ...m.authenticationResults.map((value) => ({ name: 'Authentication-Results', value }))] : null,
  };
  if (!select) {
    const { internetMessageHeaders: _omit, ...rest } = all;
    return rest;
  }
  const keep = new Set(['id', ...select.split(',').map((s) => s.trim())]);
  return Object.fromEntries(Object.entries(all).filter(([k]) => keep.has(k)));
}

function eventJson(e: FakeEvent, prefer: string, select: string | undefined): G {
  const utc = /outlook\.timezone="UTC"/.test(prefer);
  const wall = (iso: string, tz: string): string => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(iso));
    const g = (t: string) => parts.find((x) => x.type === t)!.value;
    return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}.0000000`;
  };
  // Without `Prefer: outlook.timezone="UTC"` Graph answers in the event's own zone: a client that forgets the header misreads every time.
  const out = (iso: string): G => (utc ? { dateTime: `${iso.replace(/Z$/, '')}.0000000`, timeZone: 'UTC' } : { dateTime: wall(iso, e.originalStartTimeZone), timeZone: e.originalStartTimeZone });
  const all: G = {
    id: e.id,
    subject: e.subject,
    body: { contentType: 'text', content: e.body },
    location: { displayName: e.location },
    start: out(e.start),
    end: out(e.end),
    isAllDay: e.isAllDay,
    isCancelled: e.isCancelled,
    originalStartTimeZone: e.originalStartTimeZone,
    responseStatus: { response: 'organizer' },
    attendees: e.attendees.map((a) => ({ type: 'required', status: { response: a.response }, emailAddress: { address: a.address, ...(a.name ? { name: a.name } : {}) } })),
    organizer: { emailAddress: { address: e.organizer } },
    isOrganizer: e.isOrganizer,
    showAs: e.showAs,
    type: e.type,
    onlineMeeting: e.joinUrl ? { joinUrl: e.joinUrl } : null,
    webLink: `https://calendar.example.test/${e.id}`,
  };
  if (!select) return all;
  const keep = new Set(['id', ...select.split(',').map((s) => s.trim())]);
  return Object.fromEntries(Object.entries(all).filter(([k]) => keep.has(k)));
}

function parseRange(address: string): { c1: number; r1: number; c2: number; r2: number } {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(address);
  if (!m) throw new BadRequest('bad address');
  const col = (s: string) => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  return { c1: col(m[1]!), r1: Number(m[2]), c2: m[3] ? col(m[3]) : col(m[1]!), r2: m[4] ? Number(m[4]) : Number(m[2]) };
}

const col = (n: number): string => {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
};

function setCell(sheet: FakeSheet, row: number, c: number, v: unknown): void {
  const key = `${row},${c}`;
  sheet.cells.delete(key);
  sheet.formulas.delete(key);
  if (v === '' || v === null || v === undefined) return;
  if (typeof v === 'string' && v.startsWith("'")) sheet.cells.set(key, v.slice(1)); // the apostrophe makes it text
  else if (typeof v === 'string' && /^[=]/.test(v)) {
    sheet.formulas.set(key, v); // Excel evaluates it as a formula
    sheet.cells.set(key, '#EVALUATED');
  } else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') sheet.cells.set(key, v);
}

export class GraphRouter {
  constructor(
    private readonly fake: FakeGraph,
    private readonly acct: FakeAccount,
  ) {}

  handle(rec: Recorded, raw: string | Buffer | null, url: URL): Response {
    try {
      return this.dispatch(rec, raw, url) ?? err(404, 'ErrorInvalidRequest');
    } catch (e) {
      if (e instanceof BadRequest) return err(400, 'ErrorInvalidProperty');
      throw e;
    }
  }

  private get a(): FakeAccount {
    return this.acct;
  }

  private page<T>(rec: Recorded, items: T[], map: (t: T) => G): Response {
    const top = Number(rec.query.$top ?? DEFAULT_TOP);
    const from = Number(rec.query.$skiptoken ?? 0);
    const slice = items.slice(from, from + top);
    const body: G = { value: slice.map(map) };
    if (from + top < items.length) body['@odata.nextLink'] = this.fake.nextLink(rec.path, { ...rec.query, $skiptoken: String(from + top) }, this.a);
    return respond(200, body);
  }

  private dispatch(rec: Recorded, raw: string | Buffer | null, url: URL): Response | null {
    const p = rec.path;
    const m = rec.method;
    const prefer = rec.headers.prefer ?? '';
    const body = (rec.json ?? {}) as G;
    let x: RegExpExecArray | null;

    // ---- mail ----
    if (m === 'GET' && p === '/me/mailFolders') return respond(200, { value: [...this.a.folders.values()].filter((f) => !f.alias || true).map((f) => ({ id: f.id, displayName: f.name })) });
    if (m === 'GET' && (x = /^\/me\/mailFolders\/([^/]+)$/.exec(p))) {
      const f = this.a.folders.get(`F-${x[1]}`) ?? this.a.folders.get(x[1]!);
      return f ? respond(200, { id: f.id, displayName: f.name }) : err(404, 'ErrorItemNotFound');
    }
    if (m === 'GET' && p === '/me/outlook/masterCategories') return respond(200, { value: this.a.masterCategories.map((c) => ({ displayName: c })) });
    if (m === 'GET' && ((x = /^\/me\/mailFolders\/([^/]+)\/messages$/.exec(p)) || p === '/me/messages')) {
      const folder = x ? (this.a.folders.get(`F-${x[1]}`) ?? this.a.folders.get(x[1]!)) : undefined;
      if (x && !folder) return err(404, 'ErrorItemNotFound');
      let list = this.a.messages.filter((msg) => !folder || msg.folderId === folder.id);
      if (rec.query.$filter && rec.query.$search) return err(400, 'ErrorInvalidRequest'); // Graph cannot combine them
      if (rec.query.$filter) list = list.filter((msg) => filterMessage(rec.query.$filter!, msg));
      if (rec.query.$search) {
        const terms = parseSearch(rec.query.$search);
        list = list.filter((msg) => searchMessage(terms, msg));
      }
      if (rec.query.$orderby && rec.query.$orderby !== 'receivedDateTime desc') throw new BadRequest('orderby');
      list = [...list].sort((p1, p2) => Date.parse(p2.receivedDateTime) - Date.parse(p1.receivedDateTime));
      return this.page(rec, list, (msg) => messageJson(msg, prefer, rec.query.$select));
    }
    if (p === '/me/messages' && m === 'POST') return respond(201, messageJson(this.createDraft(body, null), prefer, undefined));
    if (p === '/me/sendMail' && m === 'POST') {
      const msg = this.buildMessage((body.message ?? {}) as G, null, 'F-drafts');
      this.deliver(msg, false);
      return respond(202);
    }
    if ((x = /^\/me\/messages\/([^/]+)(?:\/(.+))?$/.exec(p))) {
      const msg = this.a.messages.find((mm) => mm.id === x![1]);
      const sub = x[2];
      if (!msg) return err(404, 'ErrorItemNotFound');
      if (!sub && m === 'GET') return respond(200, messageJson(msg, prefer, rec.query.$select));
      if (!sub && m === 'PATCH') {
        if (typeof body.isRead === 'boolean') msg.isRead = body.isRead;
        if (Array.isArray(body.categories)) msg.categories = body.categories as string[];
        if (typeof body.subject === 'string') msg.subject = body.subject;
        if (body.body) {
          const b = body.body as G;
          if (b.contentType === 'html') {
            msg.html = String(b.content);
            msg.text = stripTags(String(b.content));
          } else {
            msg.text = String(b.content);
            msg.html = null;
          }
        }
        if (body.toRecipients) msg.to = fromGraph(body.toRecipients);
        if (body.ccRecipients) msg.cc = fromGraph(body.ccRecipients);
        if (body.bccRecipients) msg.bcc = fromGraph(body.bccRecipients);
        return respond(200, messageJson(msg, prefer, undefined));
      }
      if (!sub && m === 'DELETE') {
        this.a.messages.splice(this.a.messages.indexOf(msg), 1);
        return respond(204);
      }
      if (sub === 'move' && m === 'POST') {
        const dest = this.a.folders.get(`F-${body.destinationId}`) ?? this.a.folders.get(String(body.destinationId));
        if (!dest) return err(404, 'ErrorItemNotFound');
        msg.folderId = dest.id; // immutable ids: the id does not change
        return respond(201, messageJson(msg, prefer, undefined));
      }
      if (sub === 'send' && m === 'POST') {
        if (!msg.isDraft) return err(404, 'ErrorItemNotFound');
        this.deliver(msg, true);
        return respond(202);
      }
      if (sub === 'createReply' && m === 'POST') {
        const reply = this.a.addMessage({ subject: `RE: ${msg.subject}`, conversationId: msg.conversationId, folderId: 'F-drafts', isDraft: true, from: { address: this.a.email }, to: msg.from ? [msg.from] : [], text: `quoted: ${msg.text}`, replyTo: msg.id });
        return respond(201, messageJson(reply, prefer, undefined));
      }
      if (sub === 'reply' && m === 'POST') {
        const b = (body.message ?? {}) as G;
        if (b.body && body.comment) return err(400, 'ErrorInvalidRequest');
        const reply = this.buildMessage({ subject: `RE: ${msg.subject}`, ...b }, null, 'F-drafts');
        reply.conversationId = msg.conversationId;
        reply.replyTo = msg.id;
        if (reply.to.length === 0 && msg.from) reply.to = [msg.from];
        this.deliver(reply, false);
        return respond(202);
      }
      if (sub === 'attachments' && m === 'GET') return respond(200, { value: msg.attachments.map((at) => ({ '@odata.type': at.kind === 'item' ? '#microsoft.graph.itemAttachment' : '#microsoft.graph.fileAttachment', id: at.id, name: at.name, contentType: at.contentType, size: at.bytes.length })) });
      if (sub === 'attachments' && m === 'POST') {
        msg.attachments.push({ id: this.a.newId('ATT'), name: String(body.name), contentType: String(body.contentType), bytes: Buffer.from(String(body.contentBytes), 'base64') });
        return respond(201, {});
      }
      if (sub === 'attachments/createUploadSession' && m === 'POST') {
        const item = body.AttachmentItem as G;
        const sid = randomUUID();
        this.a.uploadSessions.set(sid, { target: { parentId: null, name: '', attachment: { messageId: msg.id, name: String(item.name), contentType: String(item.contentType) } }, size: Number(item.size), received: [] });
        return respond(201, { uploadUrl: `https://${FAKE_HOSTS.upload}/up/${sid}` });
      }
      if ((x = /^attachments\/([^/]+)(\/\$value)?$/.exec(sub ?? '')) && m === 'GET') {
        const at = msg.attachments.find((aa) => aa.id === x![1]);
        if (!at) return err(404, 'ErrorItemNotFound');
        if (x[2]) return new Response(new Uint8Array(at.bytes), { status: 200 });
        return respond(200, { '@odata.type': at.kind === 'item' ? '#microsoft.graph.itemAttachment' : '#microsoft.graph.fileAttachment', id: at.id, name: at.name, contentType: at.contentType, size: at.bytes.length });
      }
    }

    // ---- calendar ----
    if (m === 'GET' && p === '/me/calendars') return respond(200, { value: this.a.calendars.map((c) => ({ id: c.id, name: c.name, isDefaultCalendar: c.isDefault, canEdit: c.canEdit, owner: { address: c.owner } })) });
    if (m === 'GET' && (x = /^\/me\/calendar(?:s\/([^/]+))?\/calendarView$/.exec(p))) {
      const calId = x[1] ?? 'CAL-default';
      if (!this.a.calendars.some((c) => c.id === calId)) return err(404, 'ErrorItemNotFound');
      const from = Date.parse(rec.query.startDateTime ?? '');
      const to = Date.parse(rec.query.endDateTime ?? '');
      if (!Number.isFinite(from) || !Number.isFinite(to)) return err(400, 'ErrorInvalidRequest');
      let list = this.a.events.filter((e) => e.calendarId === calId && Date.parse(e.start) < to && Date.parse(e.end) > from);
      const f = rec.query.$filter ? new RegExp(`^contains\\(subject,${LITERAL}\\)$`).exec(rec.query.$filter) : null;
      if (rec.query.$filter && !f) throw new BadRequest('filter');
      if (f) list = list.filter((e) => has(e.subject, lit(f[1]!)));
      list = [...list].sort((p1, p2) => Date.parse(p1.start) - Date.parse(p2.start));
      return this.page(rec, list, (e) => eventJson(e, prefer, rec.query.$select));
    }
    if (m === 'POST' && (x = /^\/me\/calendar(?:s\/([^/]+))?\/events$/.exec(p))) {
      const calId = x[1] ?? 'CAL-default';
      if (typeof body.transactionId === 'string') {
        const dup = this.a.events.find((e) => e.transactionId === body.transactionId);
        if (dup) return respond(201, eventJson(dup, prefer, undefined));
      }
      const tz = String((body.start as G).timeZone);
      const toUtc = (t: G): string => wallToUtc(String(t.dateTime), String(t.timeZone));
      const attendees = (Array.isArray(body.attendees) ? (body.attendees as G[]) : []).map((at) => ({ address: String((at.emailAddress as G).address), ...(typeof (at.emailAddress as G).name === 'string' ? { name: (at.emailAddress as G).name as string } : {}), response: 'none' }));
      if (body.isOnlineMeeting && this.a.kind === 'personal') return err(400, 'ErrorInvalidRequest');
      const e = this.a.addEvent({
        subject: String(body.subject),
        body: body.body ? String((body.body as G).content) : '',
        location: body.location ? String((body.location as G).displayName) : '',
        start: toUtc(body.start as G),
        end: toUtc(body.end as G),
        isAllDay: body.isAllDay === true,
        attendees,
        transactionId: typeof body.transactionId === 'string' ? body.transactionId : null,
        joinUrl: body.isOnlineMeeting ? `https://teams.example.test/join/${randomUUID()}` : null,
        originalStartTimeZone: tz,
        calendarId: calId,
      });
      if (attendees.length > 0) this.a.invitations.push({ eventId: e.id, kind: 'invite', to: attendees.map((at) => at.address) });
      return respond(201, eventJson(e, prefer, undefined));
    }
    if ((x = /^\/me\/events\/([^/]+)(?:\/(cancel))?$/.exec(p))) {
      const e = this.a.events.find((ev) => ev.id === x![1]);
      if (!e) return err(404, 'ErrorItemNotFound');
      if (!x[2] && m === 'GET') return respond(200, eventJson(e, prefer, rec.query.$select));
      if (!x[2] && m === 'PATCH') {
        if (typeof body.subject === 'string') e.subject = body.subject;
        if (body.body) e.body = String((body.body as G).content);
        if (body.location) e.location = String((body.location as G).displayName);
        if (body.start) e.start = wallToUtc(String((body.start as G).dateTime), String((body.start as G).timeZone));
        if (body.end) e.end = wallToUtc(String((body.end as G).dateTime), String((body.end as G).timeZone));
        if (typeof body.isAllDay === 'boolean') e.isAllDay = body.isAllDay;
        if (Array.isArray(body.attendees)) e.attendees = (body.attendees as G[]).map((at) => ({ address: String((at.emailAddress as G).address), response: 'none' }));
        if (e.attendees.length > 0) this.a.invitations.push({ eventId: e.id, kind: 'update', to: e.attendees.map((at) => at.address) });
        return respond(200, eventJson(e, prefer, undefined));
      }
      if (!x[2] && m === 'DELETE') {
        this.a.events.splice(this.a.events.indexOf(e), 1);
        return respond(204);
      }
      if (x[2] && m === 'POST') {
        e.isCancelled = true;
        this.a.invitations.push({ eventId: e.id, kind: 'cancel', to: e.attendees.map((at) => at.address) });
        return respond(202);
      }
    }
    if (m === 'POST' && p === '/me/calendar/getSchedule') {
      if (this.a.kind === 'personal') return err(400, 'ErrorInvalidRequest');
      const from = Date.parse(wallToUtc(String((body.startTime as G).dateTime), 'UTC'));
      const to = Date.parse(wallToUtc(String((body.endTime as G).dateTime), 'UTC'));
      const items = this.a.events.filter((e) => !e.isCancelled && Date.parse(e.start) < to && Date.parse(e.end) > from).map((e) => ({ status: e.showAs, start: { dateTime: `${e.start.replace(/Z$/, '')}.0000000`, timeZone: 'UTC' }, end: { dateTime: `${e.end.replace(/Z$/, '')}.0000000`, timeZone: 'UTC' } }));
      return respond(200, { value: [{ scheduleId: (body.schedules as string[])[0], scheduleItems: items }] });
    }

    // ---- OneDrive ----
    if (p.startsWith('/me/drive')) return this.drive(rec, raw, url, body);
    return null;
  }

  // ---- mail helpers ----

  private buildMessage(b: G, _from: null, folderId: string): FakeMessage {
    const body = (b.body ?? {}) as G;
    const html = body.contentType === 'html';
    const msg = this.a.addMessage({
      subject: String(b.subject ?? ''),
      folderId,
      isDraft: true,
      from: { address: this.a.email, name: this.a.name },
      to: fromGraph(b.toRecipients),
      cc: fromGraph(b.ccRecipients),
      bcc: fromGraph(b.bccRecipients),
      text: html ? stripTags(String(body.content ?? '')) : String(body.content ?? ''),
      html: html ? String(body.content ?? '') : null,
      isRead: true,
      attachments: (Array.isArray(b.attachments) ? (b.attachments as G[]) : []).map((at) => ({ id: this.a.newId('ATT'), name: String(at.name), contentType: String(at.contentType), bytes: Buffer.from(String(at.contentBytes), 'base64') })),
    });
    return msg;
  }

  private createDraft(b: G, _x: null): FakeMessage {
    return this.buildMessage(b, null, 'F-drafts');
  }

  /** The message leaves the drafts folder for Sent Items and lands in the inbox of every recipient that is a fake account. */
  private deliver(msg: FakeMessage, viaDraft: boolean): void {
    const to = [...msg.to, ...msg.cc, ...msg.bcc].map((r) => r.address);
    this.a.sent.push({ to, subject: msg.subject, viaDraft });
    msg.isDraft = false;
    msg.folderId = 'F-sentitems';
    if (!this.a.messages.includes(msg)) this.a.messages.push(msg);
    for (const acct of this.fake.accounts) {
      if (acct !== this.a && to.some((t) => t.toLowerCase() === acct.email.toLowerCase())) acct.addMessage({ subject: msg.subject, text: msg.text, html: msg.html, from: { address: this.a.email, name: this.a.name }, to: msg.to, attachments: msg.attachments.map((at) => ({ ...at })), conversationId: msg.conversationId });
    }
    // To oneself: a copy lands in the inbox too (Outlook does the same).
    if (to.some((t) => t.toLowerCase() === this.a.email.toLowerCase())) this.a.addMessage({ subject: msg.subject, text: msg.text, html: msg.html, from: { address: this.a.email, name: this.a.name }, to: msg.to, attachments: msg.attachments.map((at) => ({ ...at })) });
  }

  // ---- drive ----

  private children(id: string): FakeDriveItem[] {
    return [...this.a.drive.values()].filter((i) => i.parentId === id);
  }

  private subtree(id: string): FakeDriveItem[] {
    return this.children(id).flatMap((c) => [c, ...(c.folder ? this.subtree(c.id) : [])]);
  }

  private uniqueName(parentId: string | null, name: string): string {
    const taken = new Set(this.children(parentId ?? 'root-id').map((c) => c.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 1; ; n++) if (!taken.has(`${stem} ${n}${ext}`.toLowerCase())) return `${stem} ${n}${ext}`;
  }

  private finishFile(item: FakeDriveItem): void {
    if (/\.xlsx$/i.test(item.name)) {
      item.mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      try {
        FakeGraph.registerXlsx(this.a, item);
      } catch {
        // not a workbook we generated
      }
    }
  }

  private drive(rec: Recorded, raw: string | Buffer | null, url: URL, body: G): Response | null {
    const p = rec.path;
    const m = rec.method;
    const parent = (id: string | undefined): string | null => (id === undefined ? 'root-id' : this.a.drive.has(id) ? id : null);
    let x: RegExpExecArray | null;

    if (m === 'GET' && p === '/me/drive') return respond(200, { id: `drive-${this.a.objectId.slice(0, 8)}`, driveType: this.a.kind === 'personal' ? 'personal' : 'business' });
    if (m === 'GET' && (x = /^\/me\/drive\/(?:root|items\/([^/]+))\/children$/.exec(p))) {
      const id = parent(x[1]);
      if (!id) return err(404, 'itemNotFound');
      return this.page(rec, this.children(id), driveItemJson);
    }
    if (m === 'GET' && (x = /^\/me\/drive\/(?:root|items\/([^/]+))\/search\(q='((?:[^']|'')*)'\)$/.exec(p))) {
      const id = parent(x[1]);
      if (!id) return err(404, 'itemNotFound');
      const q = lit(x[2]!);
      return this.page(rec, this.subtree(id).filter((i) => has(i.name, q)), driveItemJson);
    }
    if (m === 'GET' && (x = /^\/me\/drive\/items\/([^/]+)$/.exec(p))) {
      const i = this.a.drive.get(x[1]!);
      return i ? respond(200, driveItemJson(i)) : err(404, 'itemNotFound');
    }
    if (m === 'GET' && (x = /^\/me\/drive\/items\/([^/]+)\/content$/.exec(p))) {
      const i = this.a.drive.get(x[1]!);
      return i && !i.folder ? new Response(null, { status: 302, headers: { location: `https://${FAKE_HOSTS.download}/dl/${i.id}` } }) : err(404, 'itemNotFound');
    }
    if (m === 'POST' && (x = /^\/me\/drive\/(?:root|items\/([^/]+))\/children$/.exec(p))) {
      const id = parent(x[1]);
      if (!id) return err(404, 'itemNotFound');
      const f = this.a.addFile({ name: this.uniqueName(id, String(body.name)), parentId: id, folder: true });
      return respond(201, driveItemJson(f));
    }
    // simple upload by path: `root:/name:/content` or `items/{id}:/name:/content`
    if (m === 'PUT' && (x = /^\/me\/drive\/(?:root|items\/([^/:]+)):\/([^:]+):\/content$/.exec(p))) {
      const id = parent(x[1]);
      if (!id) return err(404, 'itemNotFound');
      if (!Buffer.isBuffer(raw)) return err(400, 'invalidRequest');
      if (raw.length > 4 * 1024 * 1024) return err(400, 'invalidRequest'); // a simple upload is under 4 MB
      const name = rec.query['@microsoft.graph.conflictBehavior'] === 'rename' ? this.uniqueName(id, x[2]!) : x[2]!;
      const item = this.a.addFile({ name, parentId: id, bytes: raw, mimeType: rec.headers['content-type'] ?? 'application/octet-stream' });
      this.finishFile(item);
      return respond(201, driveItemJson(item));
    }
    if (m === 'PUT' && (x = /^\/me\/drive\/items\/([^/]+)\/content$/.exec(p))) {
      const i = this.a.drive.get(x[1]!);
      if (!i) return err(404, 'itemNotFound');
      if (rec.headers['if-match'] && rec.headers['if-match'] !== driveItemJson(i).eTag) return err(412, 'preconditionFailed');
      if (!Buffer.isBuffer(raw)) return err(400, 'invalidRequest');
      i.bytes = raw;
      i.version++;
      i.modified = new Date().toISOString();
      this.finishFile(i);
      return respond(200, driveItemJson(i));
    }
    if (m === 'POST' && (x = /^\/me\/drive\/(?:root|items\/([^/:]+)):\/([^:]+):\/createUploadSession$/.exec(p))) {
      const id = parent(x[1]);
      if (!id) return err(404, 'itemNotFound');
      const sid = randomUUID();
      this.a.uploadSessions.set(sid, { target: { parentId: id, name: this.uniqueName(id, x[2]!) }, size: Infinity, received: [] });
      return respond(200, { uploadUrl: `https://${FAKE_HOSTS.upload}/up/${sid}` });
    }
    if (m === 'POST' && (x = /^\/me\/drive\/items\/([^/]+)\/createUploadSession$/.exec(p))) {
      const i = this.a.drive.get(x[1]!);
      if (!i) return err(404, 'itemNotFound');
      if (rec.headers['if-match'] && rec.headers['if-match'] !== driveItemJson(i).eTag) return err(412, 'preconditionFailed');
      const sid = randomUUID();
      this.a.uploadSessions.set(sid, { target: { parentId: i.parentId, name: i.name, replaceId: i.id }, size: Infinity, received: [] });
      return respond(200, { uploadUrl: `https://${FAKE_HOSTS.upload}/up/${sid}` });
    }

    // ---- the Excel workbook API ----
    if ((x = /^\/me\/drive\/items\/([^/]+)\/workbook(\/.*)?$/.exec(p))) {
      if (this.a.kind === 'personal') return err(this.fake.workbookOnPersonal, 'InvalidRequest');
      return this.workbook(rec, x[1]!, x[2] ?? '', body);
    }
    return null;
  }

  private workbook(rec: Recorded, fileId: string, sub: string, body: G): Response {
    const sheets = this.a.sheets.get(fileId);
    if (!sheets) return err(404, 'ItemNotFound');
    const m = rec.method;
    let x: RegExpExecArray | null;
    if (m === 'GET' && sub === '/worksheets') return respond(200, { value: [...sheets.keys()].map((name) => ({ name })) });
    if (!(x = /^\/worksheets\/([^/]+)(\/.*)?$/.exec(sub))) return err(404, 'ItemNotFound');
    const name = x[1]!;
    const rest = x[2] ?? '';
    const sheet = sheets.get(name);
    if (!sheet) return err(404, 'ItemNotFound');
    const bounds = () => {
      const keys = [...sheet.cells.keys()].map((k) => k.split(',').map(Number) as [number, number]);
      if (keys.length === 0) return { r1: 1, c1: 1, r2: 1, c2: 1 };
      return { r1: Math.min(...keys.map((k) => k[0])), c1: Math.min(...keys.map((k) => k[1])), r2: Math.max(...keys.map((k) => k[0])), c2: Math.max(...keys.map((k) => k[1])) };
    };
    if (m === 'GET' && rest === '/usedRange(valuesOnly=true)') {
      const b = bounds();
      return respond(200, { address: `${name}!${col(b.c1)}${b.r1}${b.c1 === b.c2 && b.r1 === b.r2 ? '' : `:${col(b.c2)}${b.r2}`}`, rowCount: b.r2 - b.r1 + 1, columnCount: b.c2 - b.c1 + 1 });
    }
    if ((x = /^\/range\(address='([^']+)'\)$/.exec(rest))) {
      const r = parseRange(x[1]!);
      if (m === 'GET') {
        const values = Array.from({ length: r.r2 - r.r1 + 1 }, (_r, i) => Array.from({ length: r.c2 - r.c1 + 1 }, (_c, j) => sheet.cells.get(`${r.r1 + i},${r.c1 + j}`) ?? ''));
        return respond(200, { address: `${name}!${x[1]}`, values });
      }
      if (m === 'PATCH') {
        const values = body.values as unknown[][];
        if (!Array.isArray(values) || values.length !== r.r2 - r.r1 + 1 || values.some((row) => row.length !== r.c2 - r.c1 + 1)) return err(400, 'InvalidArgument');
        values.forEach((row, i) => row.forEach((v, j) => setCell(sheet, r.r1 + i, r.c1 + j, v)));
        return respond(200, { address: `${name}!${x[1]}` });
      }
    }
    if (m === 'GET' && rest === '/tables') return respond(200, { value: sheet.tables.map((t) => ({ id: t.id, name: t.name })) });
    if ((x = /^\/tables\/([^/]+)(\/.*)$/.exec(rest))) {
      const t = sheet.tables.find((tb) => tb.id === x![1]);
      if (!t) return err(404, 'ItemNotFound');
      if (m === 'GET' && x[2] === '/columns') return respond(200, { value: Array.from({ length: t.width }, (_c, i) => ({ id: `col-${i}` })) });
      if (m === 'GET' && x[2] === '/dataBodyRange') return respond(200, { address: `${name}!${col(t.startCol)}${t.startRow + 1}:${col(t.startCol + t.width - 1)}${t.startRow + t.bodyRows}` });
      if (m === 'POST' && x[2] === '/rows/add') {
        const values = body.values as unknown[][];
        if (!Array.isArray(values) || values.some((row) => row.length !== t.width)) return err(400, 'InvalidArgument');
        const at = t.startRow + 1 + t.bodyRows;
        values.forEach((row, i) => row.forEach((v, j) => setCell(sheet, at + i, t.startCol + j, v)));
        t.bodyRows += values.length;
        return respond(201, { index: at - t.startRow - 1, values });
      }
    }
    return err(404, 'ItemNotFound');
  }
}

export { GRAPH_ORIGIN };
