// An in-process fake of the Google endpoints the adapter uses (E39.3, #601): OAuth (token, revoke, userinfo), Gmail, Calendar,
// Drive, Docs and Sheets, built from the documented response shapes with INVENTED data (`person-a@example.test`). It implements
// `OutboundHttp`, so the adapter runs unchanged against it with no network; nothing real is recorded here.
//
// What it checks, so a passing test means something:
//   * every request carries a bearer token that belongs to an account; the data it answers with is that account's only (two
//     connections never see each other's mail), and an unknown token is a 401;
//   * every endpoint needs the scope the decision record names; a missing scope is 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT;
//   * `drive.file` sees only files the account's app created or "picked" (`pick`), a Drive get of any other file is 404;
//   * the token endpoint checks the PKCE verifier, the redirect URI and the client secret; a refresh token that was revoked is
//     `invalid_grant`;
//   * it records every request (method, path, query, parsed body) for assertions on request shape, and can fail, drop or delay
//     the next requests to test backoff, ambiguity and abort.
// It is a double for the adapter's tests and for later issues' tests of what sits on top of it, not a model of Google.
import { createHash, randomUUID } from 'node:crypto';

import { OutboundHttp, OutboundHttpError, type OutboundRequest, type OutboundResponse } from '../../../oauth-client/outbound-http';
import { SCOPE } from '../google.scopes';

export interface RecordedRequest {
  method: string;
  host: string;
  path: string;
  query: Record<string, string[]>;
  /** The bearer token that was presented (a test may compare it with an account's). */
  bearer: string | null;
  json: unknown;
  form: Record<string, string> | null;
  text: string | null;
  headers: Record<string, string>;
}

export interface FakeStub {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: number;
  headers: { name: string; value: string }[];
  text: string | null;
  html: string | null;
  attachments: { id: string; filename: string; mimeType: string; bytes: Buffer }[];
}

export interface SentMessage {
  id: string;
  raw: string;
  headers: Record<string, string[]>;
  text: string | null;
  html: string | null;
  attachments: { filename: string; contentType: string; bytes: Buffer }[];
  threadId: string | null;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  modifiedTime: string;
  size?: number;
  /** Created by the app or picked by the owner: what `drive.file` can see. */
  visible: boolean;
}

export interface FakeEvent {
  id: string;
  calendarId: string;
  body: Record<string, unknown>;
  sendUpdates: string | null;
}

const b64u = (s: string | Buffer): string => Buffer.from(s).toString('base64url');
const isoNow = () => new Date().toISOString();
const json = (status: number, body: unknown, headers: Record<string, string> = {}): OutboundResponse => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const gerr = (status: number, gstatus: string, reason: string, message = 'fake error') => json(status, { error: { code: status, message, status: gstatus, errors: [{ reason, message }] } });

/** An account at the fake Google: its tokens, its scopes and all of its data. */
export class FakeGoogleAccount {
  readonly sub: string;
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  revoked = false;
  // Gmail
  readonly labels = [
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'UNREAD', name: 'UNREAD', type: 'system' },
    { id: 'SENT', name: 'SENT', type: 'system' },
    { id: 'DRAFT', name: 'DRAFT', type: 'system' },
    { id: 'Label_1', name: 'Receipts', type: 'user' },
  ];
  readonly messages: GmailMessage[] = [];
  readonly sent: SentMessage[] = [];
  readonly drafts = new Map<string, SentMessage>();
  // Calendar
  readonly calendars = [{ id: 'primary', summary: 'Person A', primary: true, timeZone: 'UTC', accessRole: 'owner' }];
  readonly events: FakeEvent[] = [];
  readonly deletedEvents = new Set<string>();
  /** The `sendUpdates` each delete carried, by event id. */
  readonly deletionNotify = new Map<string, string | null>();
  busy: { calendarId: string; start: string; end: string }[] = [];
  // Drive, Docs, Sheets
  readonly files: DriveFile[] = [];
  readonly docs = new Map<string, string>();
  /** Spreadsheet id to tab to rows, as stored. */
  readonly sheets = new Map<string, Map<string, unknown[][]>>();
  readonly uploads = new Map<string, Buffer>();

  constructor(
    readonly email: string,
    readonly name: string | null,
    scopes: string[],
  ) {
    this.sub = `sub-${randomUUID().slice(0, 12)}`;
    this.accessToken = `fake-access-${randomUUID()}`;
    this.refreshToken = `fake-refresh-${randomUUID()}`;
    this.scopes = scopes;
  }

  hasScope(...any: string[]): boolean {
    return any.some((s) => this.scopes.includes(s));
  }

  addMessage(m: { id?: string; from?: string; to?: string; cc?: string; subject?: string; text?: string; html?: string; labels?: string[]; date?: Date; threadId?: string; messageId?: string; references?: string; attachments?: { filename: string; mimeType?: string; bytes: Buffer }[] }): GmailMessage {
    const id = m.id ?? `m${this.messages.length + 1}-${randomUUID().slice(0, 6)}`;
    const headers = [
      { name: 'From', value: m.from ?? 'Person B <person-b@example.test>' },
      { name: 'To', value: m.to ?? this.email },
      ...(m.cc ? [{ name: 'Cc', value: m.cc }] : []),
      { name: 'Subject', value: m.subject ?? 'Subject' },
      { name: 'Message-ID', value: m.messageId ?? `<${id}@example.test>` },
      ...(m.references ? [{ name: 'References', value: m.references }] : []),
    ];
    const msg: GmailMessage = {
      id,
      threadId: m.threadId ?? `t-${id}`,
      labelIds: m.labels ?? ['INBOX', 'UNREAD'],
      internalDate: (m.date ?? new Date()).getTime(),
      headers,
      text: m.text ?? (m.html ? null : 'Body'),
      html: m.html ?? null,
      attachments: (m.attachments ?? []).map((a, i) => ({ id: `att-${id}-${i}`, filename: a.filename, mimeType: a.mimeType ?? 'application/octet-stream', bytes: a.bytes })),
    };
    this.messages.push(msg);
    return msg;
  }

  addSheet(name = 'Sheet1', headers?: string[]): string {
    const id = `sheet-${randomUUID().slice(0, 12)}`;
    this.files.push({ id, name, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [], modifiedTime: isoNow(), visible: true });
    this.sheets.set(id, new Map([['Sheet1', headers ? [headers] : []]]));
    return id;
  }

  addDoc(title: string, text: string, opts: { visible?: boolean } = {}): string {
    const id = `doc-${randomUUID().slice(0, 12)}`;
    this.files.push({ id, name: title, mimeType: 'application/vnd.google-apps.document', parents: [], modifiedTime: isoNow(), visible: opts.visible ?? true });
    this.docs.set(id, text);
    return id;
  }

  /** The owner picked this file in the Google Picker: `drive.file` now sees it. */
  pick(id: string): void {
    const f = this.files.find((x) => x.id === id);
    if (f) f.visible = true;
  }
}

interface Pending {
  challenge: string;
  scopes: string[];
  redirectUri: string;
  clientId: string;
}

interface Code {
  account: FakeGoogleAccount;
  scopes: string[];
  pending: Pending;
  noRefresh: boolean;
}

/** The fake Google. Pass it where an `OutboundHttp` is expected. */
export class FakeGoogle extends OutboundHttp {
  readonly requests: RecordedRequest[] = [];
  readonly accounts: FakeGoogleAccount[] = [];
  /** The OAuth client the console is configured with. */
  client = { id: 'fake-client-id', secret: 'fake-client-secret' };
  /** Milliseconds each request takes (to test abort). */
  latencyMs = 0;
  private readonly stubs: { match: RegExp; stub: FakeStub | 'network' | 'timeout'; times: number }[] = [];
  private readonly codes = new Map<string, Code>();
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  /** A new account holding these scopes (default: everything the adapter can ask for). */
  addAccount(opts: { email?: string; name?: string | null; scopes?: string[] } = {}): FakeGoogleAccount {
    const a = new FakeGoogleAccount(opts.email ?? `person-${this.accounts.length + 1}@example.test`, opts.name ?? 'Person A', opts.scopes ?? Object.values(SCOPE).filter((s) => s !== SCOPE.calendar));
    this.accounts.push(a);
    return a;
  }

  /** The next `times` requests whose "METHOD host/path" matches get this answer instead (or a lost connection). */
  failNext(match: RegExp | string, stub: FakeStub | 'network' | 'timeout', times = 1): void {
    this.stubs.push({ match: typeof match === 'string' ? new RegExp(match) : match, stub, times });
  }

  requestsTo(match: RegExp | string): RecordedRequest[] {
    const re = typeof match === 'string' ? new RegExp(match) : match;
    return this.requests.filter((r) => re.test(`${r.method} ${r.host}${r.path}`));
  }

  /** What the browser does at Google: the account consents to the URL's scopes (minus `deny`) and the code comes back. */
  consent(authorizeUrl: string, account: FakeGoogleAccount, opts: { deny?: string[]; noRefreshToken?: boolean } = {}): { code: string; state: string } {
    const u = new URL(authorizeUrl);
    const p = u.searchParams;
    const requested = (p.get('scope') ?? '').split(' ').filter(Boolean);
    const granted = requested.filter((s) => !(opts.deny ?? []).includes(s));
    if (p.get('include_granted_scopes') === 'true') for (const s of account.scopes) if (!granted.includes(s)) granted.push(s);
    const code = `fake-code-${++this.seq}-${randomUUID().slice(0, 8)}`;
    this.codes.set(code, { account, scopes: granted, pending: { challenge: p.get('code_challenge') ?? '', scopes: requested, redirectUri: p.get('redirect_uri') ?? '', clientId: p.get('client_id') ?? '' }, noRefresh: opts.noRefreshToken === true });
    return { code, state: p.get('state') ?? '' };
  }

  async check(): Promise<void> {
    // every target is allowed
  }

  /** Requests in flight right now, and the most there ever were at once (the per-connection concurrency limit). */
  inFlight = 0;
  maxInFlight = 0;

  async send(req: OutboundRequest): Promise<OutboundResponse> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      return await this.handle(req);
    } finally {
      this.inFlight--;
    }
  }

  private async handle(req: OutboundRequest): Promise<OutboundResponse> {
    const url = new URL(req.url);
    const q: Record<string, string[]> = {};
    for (const [k, v] of url.searchParams) (q[k] ??= []).push(v);
    const headers = Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1] ?? null;
    const ct = headers['content-type'] ?? '';
    let parsed: unknown = null;
    let form: Record<string, string> | null = null;
    if (req.body !== undefined) {
      if (ct.startsWith('application/json')) parsed = JSON.parse(req.body);
      else if (ct.startsWith('application/x-www-form-urlencoded')) form = Object.fromEntries(new URLSearchParams(req.body));
    }
    const rec: RecordedRequest = { method: req.method, host: url.host, path: url.pathname, query: q, bearer, json: parsed, form, text: req.body ?? null, headers };
    this.requests.push(rec);
    if (req.signal?.aborted) throw new OutboundHttpError('aborted', 'The request was cancelled.');
    if (this.latencyMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.latencyMs);
        req.signal?.addEventListener('abort', () => (clearTimeout(t), reject(new OutboundHttpError('aborted', 'The request was cancelled.'))), { once: true });
      });
    }
    const label = `${req.method} ${url.host}${url.pathname}`;
    const stub = this.stubs.find((s) => s.times > 0 && s.match.test(label));
    if (stub) {
      stub.times--;
      if (stub.stub === 'network') throw new OutboundHttpError('network', 'Network error.');
      if (stub.stub === 'timeout') throw new OutboundHttpError('timeout', 'The server did not answer in time.');
      return json(stub.stub.status, stub.stub.body ?? {}, stub.stub.headers);
    }
    return this.route(rec);
  }

  // ---------------------------------------------------------------------------------------------------------------------------

  private account(rec: RecordedRequest): FakeGoogleAccount | null {
    const a = this.accounts.find((x) => x.accessToken === rec.bearer && !x.revoked);
    return a ?? null;
  }

  private route(rec: RecordedRequest): OutboundResponse {
    const { host, path } = rec;
    if (host === 'oauth2.googleapis.com') return this.oauthEndpoint(rec);
    const account = this.account(rec);
    if (!account) return gerr(401, 'UNAUTHENTICATED', 'authError', 'Invalid Credentials');
    if (host === 'openidconnect.googleapis.com') return json(200, { sub: account.sub, email: account.email, name: account.name, email_verified: true });
    if (host === 'gmail.googleapis.com') return this.gmail(rec, account, path.replace('/gmail/v1/users/me', ''));
    if (host === 'www.googleapis.com' && path.startsWith('/calendar/v3')) return this.calendar(rec, account, path.replace('/calendar/v3', ''));
    if (host === 'www.googleapis.com' && path.startsWith('/upload/drive/v3')) return this.upload(rec, account);
    if (host === 'www.googleapis.com' && path.startsWith('/drive/v3')) return this.drive(rec, account, path.replace('/drive/v3', ''));
    if (host === 'docs.googleapis.com') return this.docsApi(rec, account, path.replace('/v1/documents', ''));
    if (host === 'sheets.googleapis.com') return this.sheetsApi(rec, account, path.replace('/v4/spreadsheets', ''));
    return gerr(404, 'NOT_FOUND', 'notFound');
  }

  private oauthEndpoint(rec: RecordedRequest): OutboundResponse {
    const f = rec.form ?? {};
    const basic = /^Basic (.+)$/.exec(rec.headers.authorization ?? '')?.[1];
    let id = f.client_id;
    let secret = f.client_secret;
    if (basic) [id, secret] = Buffer.from(basic, 'base64').toString().split(':').map(decodeURIComponent) as [string, string];
    if (id !== this.client.id || (rec.path === '/token' && secret !== this.client.secret)) return json(401, { error: 'invalid_client' });
    if (rec.path === '/revoke') {
      const a = this.accounts.find((x) => x.accessToken === f.token || x.refreshToken === f.token);
      if (!a) return json(400, { error: 'invalid_token' });
      a.revoked = true;
      return json(200, {});
    }
    if (rec.path !== '/token') return json(404, {});
    if (f.grant_type === 'authorization_code') {
      const c = this.codes.get(f.code ?? '');
      this.codes.delete(f.code ?? '');
      if (!c) return json(400, { error: 'invalid_grant' });
      const challenge = createHash('sha256').update(f.code_verifier ?? '').digest('base64url');
      if (challenge !== c.pending.challenge || f.redirect_uri !== c.pending.redirectUri) return json(400, { error: 'invalid_grant' });
      c.account.scopes = [...new Set([...c.account.scopes, ...c.scopes])];
      c.account.revoked = false;
      c.account.accessToken = `fake-access-${randomUUID()}`;
      return json(200, { access_token: c.account.accessToken, expires_in: 3599, token_type: 'Bearer', scope: c.scopes.join(' '), ...(c.noRefresh ? {} : { refresh_token: c.account.refreshToken }) });
    }
    if (f.grant_type === 'refresh_token') {
      const a = this.accounts.find((x) => x.refreshToken === f.refresh_token);
      if (!a || a.revoked) return json(400, { error: 'invalid_grant' });
      a.accessToken = `fake-access-${randomUUID()}`;
      return json(200, { access_token: a.accessToken, expires_in: 3599, token_type: 'Bearer', scope: a.scopes.join(' ') });
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  private needs(a: FakeGoogleAccount, ...scopes: string[]): OutboundResponse | null {
    return a.hasScope(...scopes) ? null : json(403, { error: { code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } });
  }

  // ---- Gmail -----------------------------------------------------------------------------------------------------------------

  private payloadOf(m: GmailMessage) {
    const textPart = (mime: string, s: string) => ({ partId: '0', mimeType: mime, filename: '', headers: [{ name: 'Content-Type', value: `${mime}; charset=UTF-8` }], body: { size: Buffer.byteLength(s), data: b64u(s) } });
    const bodies = [...(m.text !== null ? [textPart('text/plain', m.text)] : []), ...(m.html !== null ? [textPart('text/html', m.html)] : [])];
    const body = bodies.length > 1 ? { partId: '', mimeType: 'multipart/alternative', filename: '', headers: [], body: { size: 0 }, parts: bodies } : (bodies[0] ?? textPart('text/plain', ''));
    if (m.attachments.length === 0) return { ...body, headers: [...m.headers, ...(body.headers ?? [])] };
    return {
      partId: '',
      mimeType: 'multipart/mixed',
      filename: '',
      headers: m.headers,
      body: { size: 0 },
      parts: [body, ...m.attachments.map((a) => ({ partId: a.id, mimeType: a.mimeType, filename: a.filename, headers: [], body: { size: a.bytes.length, attachmentId: a.id } }))],
    };
  }

  private gmailMatch(m: GmailMessage, q: string | undefined, labelIds: string[]): boolean {
    if (labelIds.some((l) => !m.labelIds.includes(l))) return false;
    if (!q) return true;
    const hv = (n: string) => (m.headers.find((h) => h.name.toLowerCase() === n)?.value ?? '').toLowerCase();
    for (const t of q.matchAll(/(-?[a-z]+:)?("[^"]*"|\S+)/g)) {
      const op = t[1] ?? '';
      const val = t[2]!.replace(/^"|"$/g, '').toLowerCase();
      if (op === 'from:' && !hv('from').includes(val)) return false;
      if (op === 'to:' && !hv('to').includes(val)) return false;
      if (op === 'subject:' && !hv('subject').includes(val)) return false;
      if (op === 'after:' && !(m.internalDate / 1000 >= Number(val))) return false;
      if (op === 'before:' && !(m.internalDate / 1000 < Number(val))) return false;
      if (op === 'is:' && val === 'unread' && !m.labelIds.includes('UNREAD')) return false;
      if (op === 'is:' && val === 'read' && m.labelIds.includes('UNREAD')) return false;
      if (op === 'has:' && val === 'attachment' && m.attachments.length === 0) return false;
      if (op === '-has:' && val === 'attachment' && m.attachments.length > 0) return false;
      if (op === '') {
        const hay = `${hv('subject')} ${(m.text ?? '').toLowerCase()} ${(m.html ?? '').toLowerCase()}`;
        if (!hay.includes(val)) return false;
      }
    }
    return true;
  }

  private gmail(rec: RecordedRequest, a: FakeGoogleAccount, path: string): OutboundResponse {
    const read = [SCOPE.gmailRead, SCOPE.gmailModify];
    const qp = (k: string) => rec.query[k]?.[0];
    if (rec.method === 'GET' && path === '/labels') return this.needs(a, ...read) ?? json(200, { labels: a.labels });
    if (rec.method === 'GET' && path === '/messages') {
      const denied = this.needs(a, ...read);
      if (denied) return denied;
      const hits = a.messages.filter((m) => this.gmailMatch(m, qp('q'), rec.query.labelIds ?? [])).sort((x, y) => y.internalDate - x.internalDate);
      const start = Number(qp('pageToken') ?? 0);
      const size = Number(qp('maxResults') ?? 100);
      const slice = hits.slice(start, start + size);
      return json(200, { ...(slice.length ? { messages: slice.map((m) => ({ id: m.id, threadId: m.threadId })) } : {}), ...(start + size < hits.length ? { nextPageToken: String(start + size) } : {}), resultSizeEstimate: hits.length });
    }
    let m = /^\/messages\/([^/]+)$/.exec(path);
    if (rec.method === 'GET' && m) {
      const denied = this.needs(a, ...read);
      if (denied) return denied;
      const msg = a.messages.find((x) => x.id === decodeURIComponent(m![1]!));
      if (!msg) return gerr(404, 'NOT_FOUND', 'notFound', 'Requested entity was not found.');
      return json(200, { id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds, snippet: (msg.text ?? '').slice(0, 80).replace(/'/g, '&#39;'), internalDate: String(msg.internalDate), payload: this.payloadOf(msg) });
    }
    m = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path);
    if (rec.method === 'GET' && m) {
      const denied = this.needs(a, ...read);
      if (denied) return denied;
      const att = a.messages.find((x) => x.id === decodeURIComponent(m![1]!))?.attachments.find((x) => x.id === decodeURIComponent(m![2]!));
      return att ? json(200, { size: att.bytes.length, data: b64u(att.bytes) }) : gerr(404, 'NOT_FOUND', 'notFound');
    }
    if (rec.method === 'POST' && path === '/messages/send') {
      const denied = this.needs(a, SCOPE.gmailSend, SCOPE.gmailModify);
      if (denied) return denied;
      const body = rec.json as { raw?: string; threadId?: string };
      const s = parseRaw(`sent-${a.sent.length + 1}-${randomUUID().slice(0, 6)}`, body.raw ?? '', body.threadId ?? null);
      a.sent.push(s);
      return json(200, { id: s.id, threadId: s.threadId ?? `t-${s.id}`, labelIds: ['SENT'] });
    }
    if (rec.method === 'POST' && path === '/drafts') {
      const denied = this.needs(a, SCOPE.gmailModify);
      if (denied) return denied;
      const body = rec.json as { message?: { raw?: string; threadId?: string } };
      const id = `draft-${randomUUID().slice(0, 8)}`;
      a.drafts.set(id, parseRaw(id, body.message?.raw ?? '', body.message?.threadId ?? null));
      return json(200, { id, message: { id: `dm-${id}` } });
    }
    if (rec.method === 'POST' && path === '/drafts/send') {
      const denied = this.needs(a, SCOPE.gmailModify, SCOPE.gmailSend);
      if (denied) return denied;
      const id = (rec.json as { id?: string }).id ?? '';
      const d = a.drafts.get(id);
      if (!d) return gerr(404, 'NOT_FOUND', 'notFound');
      a.drafts.delete(id);
      a.sent.push({ ...d, id: `sent-${d.id}` });
      return json(200, { id: `sent-${d.id}`, labelIds: ['SENT'] });
    }
    m = /^\/messages\/([^/]+)\/modify$/.exec(path);
    if (rec.method === 'POST' && m) {
      const denied = this.needs(a, SCOPE.gmailModify);
      if (denied) return denied;
      const msg = a.messages.find((x) => x.id === decodeURIComponent(m![1]!));
      if (!msg) return gerr(404, 'NOT_FOUND', 'notFound');
      const b = rec.json as { addLabelIds?: string[]; removeLabelIds?: string[] };
      msg.labelIds = [...new Set([...msg.labelIds, ...(b.addLabelIds ?? [])])].filter((l) => !(b.removeLabelIds ?? []).includes(l));
      return json(200, { id: msg.id, labelIds: msg.labelIds });
    }
    return gerr(404, 'NOT_FOUND', 'notFound');
  }

  // ---- Calendar --------------------------------------------------------------------------------------------------------------

  private calendar(rec: RecordedRequest, a: FakeGoogleAccount, path: string): OutboundResponse {
    const read = [SCOPE.calendarRead, SCOPE.calendarEvents, SCOPE.calendar];
    const write = [SCOPE.calendarEvents, SCOPE.calendar];
    const qp = (k: string) => rec.query[k]?.[0];
    if (rec.method === 'GET' && path === '/users/me/calendarList') return this.needs(a, ...read) ?? json(200, { items: a.calendars });
    if (rec.method === 'POST' && path === '/freeBusy') {
      const denied = this.needs(a, ...read);
      if (denied) return denied;
      const b = rec.json as { timeMin: string; timeMax: string; items: { id: string }[] };
      return json(200, { calendars: Object.fromEntries(b.items.map((i) => [i.id, { busy: a.busy.filter((x) => x.calendarId === i.id && x.end > b.timeMin && x.start < b.timeMax).map((x) => ({ start: x.start, end: x.end })) }])) });
    }
    let m = /^\/calendars\/([^/]+)\/events$/.exec(path);
    if (m && rec.method === 'GET') {
      const denied = this.needs(a, ...read);
      if (denied) return denied;
      const cal = decodeURIComponent(m[1]!);
      const timeMin = qp('timeMin') ?? '';
      const timeMax = qp('timeMax') ?? '';
      const text = (qp('q') ?? '').toLowerCase();
      const hits = a.events.filter((e) => e.calendarId === cal && String((e.body.end as { dateTime?: string; date?: string }).dateTime ?? (e.body.end as { date?: string }).date) > timeMin.slice(0, 10) && String((e.body.start as { dateTime?: string; date?: string }).dateTime ?? (e.body.start as { date?: string }).date) < timeMax && (!text || String(e.body.summary).toLowerCase().includes(text)));
      const start = Number(qp('pageToken') ?? 0);
      const size = Number(qp('maxResults') ?? 250);
      return json(200, { items: hits.slice(start, start + size).map((e) => ({ id: e.id, status: 'confirmed', ...e.body })), ...(start + size < hits.length ? { nextPageToken: String(start + size) } : {}) });
    }
    if (m && rec.method === 'POST') {
      const denied = this.needs(a, ...write);
      if (denied) return denied;
      const cal = decodeURIComponent(m[1]!);
      const body = rec.json as Record<string, unknown>;
      const id = String(body.id ?? randomUUID());
      if (a.events.some((e) => e.id === id) || a.deletedEvents.has(id)) return gerr(409, 'ALREADY_EXISTS', 'duplicate', 'The requested identifier already exists.');
      const stored = { ...body };
      delete stored.id;
      if ((body as { conferenceData?: unknown }).conferenceData) (stored as Record<string, unknown>).hangoutLink = 'https://meet.example.test/fake';
      const attendees = (body.attendees as { email: string; displayName?: string }[] | undefined)?.map((x) => ({ ...x, responseStatus: 'needsAction' }));
      if (attendees) stored.attendees = attendees;
      a.events.push({ id, calendarId: cal, body: stored, sendUpdates: qp('sendUpdates') ?? null });
      return json(200, { id, status: 'confirmed', ...stored });
    }
    m = /^\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(path);
    if (m) {
      const cal = decodeURIComponent(m[1]!);
      const eid = decodeURIComponent(m[2]!);
      const ev = a.events.find((e) => e.id === eid && e.calendarId === cal);
      if (rec.method === 'GET') {
        const denied = this.needs(a, ...read);
        if (denied) return denied;
        return ev ? json(200, { id: ev.id, status: 'confirmed', ...ev.body }) : gerr(404, 'NOT_FOUND', 'notFound');
      }
      const denied = this.needs(a, ...write);
      if (denied) return denied;
      if (rec.method === 'PATCH') {
        if (!ev) return gerr(404, 'NOT_FOUND', 'notFound');
        Object.assign(ev.body, rec.json as object);
        ev.sendUpdates = qp('sendUpdates') ?? null;
        return json(200, { id: ev.id, status: 'confirmed', ...ev.body });
      }
      if (rec.method === 'DELETE') {
        if (!ev) return a.deletedEvents.has(eid) ? gerr(410, 'GONE', 'deleted', 'Resource has been deleted') : gerr(404, 'NOT_FOUND', 'notFound');
        a.events.splice(a.events.indexOf(ev), 1);
        a.deletedEvents.add(eid);
        a.deletionNotify.set(eid, qp('sendUpdates') ?? null);
        return { status: 204, headers: {}, body: '' };
      }
    }
    return gerr(404, 'NOT_FOUND', 'notFound');
  }

  // ---- Drive -----------------------------------------------------------------------------------------------------------------

  private canSee(a: FakeGoogleAccount, f: DriveFile): boolean {
    return f.visible && a.hasScope(SCOPE.driveFile);
  }

  private fileOut(f: DriveFile) {
    return { id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, modifiedTime: f.modifiedTime, webViewLink: `https://drive.example.test/${f.id}`, ...(f.size !== undefined ? { size: String(f.size) } : {}) };
  }

  private drive(rec: RecordedRequest, a: FakeGoogleAccount, path: string): OutboundResponse {
    const qp = (k: string) => rec.query[k]?.[0];
    if (rec.method === 'GET' && path === '/about') return this.needs(a, SCOPE.driveFile) ?? json(200, { user: { kind: 'drive#user' } });
    if (rec.method === 'GET' && path === '/files') {
      const denied = this.needs(a, SCOPE.driveFile);
      if (denied) return denied;
      const q = qp('q') ?? '';
      let hits = a.files.filter((f) => this.canSee(a, f));
      for (const m of q.matchAll(/fullText contains '((?:[^'\\]|\\.)*)'/g)) hits = hits.filter((f) => f.name.toLowerCase().includes(m[1]!.replace(/\\(.)/g, '$1').toLowerCase()));
      const mt = /mimeType = '([^']+)'/.exec(q)?.[1];
      if (mt) hits = hits.filter((f) => f.mimeType === mt);
      const parent = /'((?:[^'\\]|\\.)*)' in parents/.exec(q)?.[1];
      if (parent) hits = hits.filter((f) => f.parents.includes(parent));
      const start = Number(qp('pageToken') ?? 0);
      const size = Number(qp('pageSize') ?? 100);
      return json(200, { files: hits.slice(start, start + size).map((f) => this.fileOut(f)), ...(start + size < hits.length ? { nextPageToken: String(start + size) } : {}) });
    }
    const m = /^\/files\/([^/]+)$/.exec(path);
    if (rec.method === 'GET' && m) {
      const denied = this.needs(a, SCOPE.driveFile);
      if (denied) return denied;
      const f = a.files.find((x) => x.id === decodeURIComponent(m[1]!));
      return f && this.canSee(a, f) ? json(200, this.fileOut(f)) : gerr(404, 'NOT_FOUND', 'notFound', 'File not found.');
    }
    if (rec.method === 'POST' && path === '/files') {
      const denied = this.needs(a, SCOPE.driveFile);
      if (denied) return denied;
      const b = rec.json as { name: string; mimeType: string; parents?: string[] };
      const f: DriveFile = { id: `file-${randomUUID().slice(0, 12)}`, name: b.name, mimeType: b.mimeType, parents: b.parents ?? [], modifiedTime: isoNow(), visible: true };
      a.files.push(f);
      if (f.mimeType === 'application/vnd.google-apps.document') a.docs.set(f.id, '');
      if (f.mimeType === 'application/vnd.google-apps.spreadsheet') a.sheets.set(f.id, new Map([['Sheet1', []]]));
      return json(200, this.fileOut(f));
    }
    return gerr(404, 'NOT_FOUND', 'notFound');
  }

  private upload(rec: RecordedRequest, a: FakeGoogleAccount): OutboundResponse {
    const denied = this.needs(a, SCOPE.driveFile);
    if (denied) return denied;
    const boundary = /boundary=(\S+)/.exec(rec.headers['content-type'] ?? '')?.[1];
    if (!boundary || !rec.text) return gerr(400, 'INVALID_ARGUMENT', 'badRequest');
    const parts = rec.text.split(`--${boundary}`).slice(1, -1).map((p) => p.replace(/^\r\n/, '').replace(/\r\n$/, ''));
    const [metaPart, mediaPart] = parts;
    if (!metaPart || !mediaPart) return gerr(400, 'INVALID_ARGUMENT', 'badRequest');
    const meta = JSON.parse(metaPart.split('\r\n\r\n')[1]!) as { name: string; parents?: string[] };
    const [mh, ...mb] = mediaPart.split('\r\n\r\n');
    const mime = /Content-Type: (\S+)/i.exec(mh!)?.[1] ?? 'application/octet-stream';
    const bytes = /base64/i.test(mh!) ? Buffer.from(mb.join('\r\n\r\n'), 'base64') : Buffer.from(mb.join('\r\n\r\n'));
    const f: DriveFile = { id: `file-${randomUUID().slice(0, 12)}`, name: meta.name, mimeType: mime, parents: meta.parents ?? [], modifiedTime: isoNow(), size: bytes.length, visible: true };
    a.files.push(f);
    a.uploads.set(f.id, bytes);
    return json(200, this.fileOut(f));
  }

  // ---- Docs ------------------------------------------------------------------------------------------------------------------

  private docsApi(rec: RecordedRequest, a: FakeGoogleAccount, path: string): OutboundResponse {
    const write = [SCOPE.documents];
    const read = [SCOPE.documents, SCOPE.documentsRead];
    const batch = /^\/([^/]+):batchUpdate$/.exec(path);
    if (rec.method === 'POST' && batch) {
      const denied = this.needs(a, ...write);
      if (denied) return denied;
      const id = decodeURIComponent(batch[1]!);
      if (!a.docs.has(id)) return gerr(404, 'NOT_FOUND', 'notFound');
      for (const r of (rec.json as { requests: { insertText?: { text: string } }[] }).requests) if (r.insertText) a.docs.set(id, a.docs.get(id)! + r.insertText.text);
      return json(200, { documentId: id, replies: [{}] });
    }
    const m = /^\/([^/]+)$/.exec(path);
    if (rec.method === 'GET' && m) {
      const denied = this.needs(a, ...read);
      if (denied) return denied;
      const id = decodeURIComponent(m[1]!);
      const text = a.docs.get(id);
      if (text === undefined) return gerr(404, 'NOT_FOUND', 'notFound', 'Requested entity was not found.');
      const content = text.split(/(?<=\n)/).filter(Boolean).map((line) => ({ paragraph: { elements: [{ textRun: { content: line.endsWith('\n') ? line : `${line}\n` } }] } }));
      return json(200, { documentId: id, body: { content } });
    }
    return gerr(404, 'NOT_FOUND', 'notFound');
  }

  // ---- Sheets ----------------------------------------------------------------------------------------------------------------

  private sheetsApi(rec: RecordedRequest, a: FakeGoogleAccount, path: string): OutboundResponse {
    const write = [SCOPE.sheets];
    const read = [SCOPE.sheets, SCOPE.sheetsRead];
    const m = /^\/([^/]+)\/values\/([^/:]+)(:append)?$/.exec(path);
    if (!m) return gerr(404, 'NOT_FOUND', 'notFound');
    const id = decodeURIComponent(m[1]!);
    const range = decodeURIComponent(m[2]!);
    const tabs = a.sheets.get(id);
    const need = rec.method === 'GET' ? read : write;
    const denied = this.needs(a, ...need);
    if (denied) return denied;
    if (!tabs) return gerr(404, 'NOT_FOUND', 'notFound', 'Requested entity was not found.');
    const tabName = /^'((?:[^']|'')*)'(?:!|$)/.exec(range)?.[1]?.replace(/''/g, "'") ?? [...tabs.keys()][0]!;
    const rows = tabs.get(tabName);
    if (!rows) return gerr(400, 'INVALID_ARGUMENT', 'badRequest', 'Unable to parse range');
    const a1 = range.includes('!') ? range.slice(range.indexOf('!') + 1) : /^'/.test(range) ? '' : range;
    if (rec.method === 'GET') {
      const lastRow = /[A-Za-z]+(\d+)$/.exec(a1)?.[1];
      const cap = lastRow ? Number(lastRow) : rows.length;
      return json(200, { range, majorDimension: 'ROWS', values: rows.slice(0, cap) });
    }
    const body = rec.json as { values: unknown[][] };
    if (m[3]) {
      const first = rows.length + 1;
      rows.push(...body.values.map((r) => [...r]));
      return json(200, { spreadsheetId: id, updates: { updatedRange: `${tabName}!A${first}:${colName(Math.max(...body.values.map((r) => r.length)))}${rows.length}`, updatedRows: body.values.length, updatedCells: body.values.reduce((n, r) => n + r.length, 0) } });
    }
    rows.splice(0, rows.length, ...body.values.map((r) => [...r]));
    return json(200, { spreadsheetId: id, updatedRange: range });
  }
}

const colName = (n: number): string => String.fromCharCode(64 + Math.min(26, Math.max(1, n)));

// ---- A small independent MIME reader for what the adapter sends --------------------------------------------------------------

function unfold(block: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const lines = block.split('\r\n');
  const unfolded: string[] = [];
  for (const l of lines) {
    if (/^[ \t]/.test(l) && unfolded.length) unfolded[unfolded.length - 1] += l;
    else unfolded.push(l);
  }
  for (const l of unfolded) {
    const i = l.indexOf(':');
    if (i > 0) (out[l.slice(0, i).toLowerCase()] ??= []).push(l.slice(i + 1).trim());
  }
  return out;
}

function parseEntity(raw: string): { headers: Record<string, string[]>; text: string | null; html: string | null; attachments: SentMessage['attachments'] } {
  const idx = raw.indexOf('\r\n\r\n');
  const headers = unfold(idx < 0 ? raw : raw.slice(0, idx));
  const body = idx < 0 ? '' : raw.slice(idx + 4);
  const ct = headers['content-type']?.[0] ?? 'text/plain';
  const boundary = /boundary="?([^";]+)"?/.exec(ct)?.[1];
  const result = { headers, text: null as string | null, html: null as string | null, attachments: [] as SentMessage['attachments'] };
  if (boundary && ct.startsWith('multipart/')) {
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith('--')) break;
      const sub = parseEntity(part.replace(/^\r\n/, ''));
      result.text ??= sub.text;
      result.html ??= sub.html;
      result.attachments.push(...sub.attachments);
    }
    return result;
  }
  const decoded = /base64/i.test(headers['content-transfer-encoding']?.[0] ?? '') ? Buffer.from(body.replace(/\s+/g, ''), 'base64') : Buffer.from(body, 'utf8');
  const disp = headers['content-disposition']?.[0] ?? '';
  if (/attachment/i.test(disp)) {
    const star = /filename\*=UTF-8''([^;]+)/i.exec(disp)?.[1];
    const plain = /filename="([^"]*)"/i.exec(disp)?.[1];
    result.attachments.push({ filename: star ? decodeURIComponent(star) : (plain ?? ''), contentType: ct.split(';')[0]!.trim(), bytes: decoded });
  } else if (ct.startsWith('text/html')) result.html = decoded.toString('utf8');
  else result.text = decoded.toString('utf8');
  return result;
}

function parseRaw(id: string, rawB64u: string, threadId: string | null): SentMessage {
  const raw = Buffer.from(rawB64u, 'base64url').toString('utf8');
  const e = parseEntity(raw);
  return { id, raw, headers: e.headers, text: e.text, html: e.html, attachments: e.attachments, threadId };
}
