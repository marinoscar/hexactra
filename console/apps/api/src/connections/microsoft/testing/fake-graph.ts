// An in-process fake of the Microsoft endpoints the Microsoft provider uses (E39.4, #602): the identity platform (token endpoint) and
// Graph v1.0 (mail, calendar, OneDrive, the Excel workbook API) plus the upload and download hosts. Built from the documented
// response shapes with INVENTED data only (`person-a@example.test`); no real response is recorded. It is a `fetch` replacement:
// `new GraphClient({ fetch: fake.fetch, ... })`, `new MicrosoftConnectionAdapter({ fetch: fake.fetch })`.
//
// It models just enough behaviour to catch the mistakes that matter: the `$filter` and `$search` forms the adapter builds are really
// parsed (so an unescaped quote or an operator inside a value shows up), a send delivers to another fake account's inbox, an event
// with attendees records an invitation (Graph always sends one), a workbook cell written with a leading `=` is evaluated as a formula
// unless it carries the apostrophe, an `If-Match` that is not the current eTag is a 412, and a refresh token rotates.
//
// Failures are scripted per request (`throttle`, `fail`, `failAfter`, `drop`), so retry, backoff and ambiguity are tested without a clock.
import { randomUUID } from 'node:crypto';

import { codeChallengeS256 } from '../../../oauth-client/pkce';
import { CONSUMER_TENANT_ID } from '../microsoft.constants';
import { docxToText } from '../ooxml';
import { readZip } from '../zip';

type G = Record<string, unknown>;

export interface FakeAttachment {
  id: string;
  name: string;
  contentType: string;
  bytes: Buffer;
  kind?: 'file' | 'item';
}

export interface FakeMessage {
  id: string;
  conversationId: string;
  folderId: string;
  from: { address: string; name?: string } | null;
  to: { address: string; name?: string }[];
  cc: { address: string; name?: string }[];
  bcc: { address: string; name?: string }[];
  subject: string;
  text: string;
  html: string | null;
  receivedDateTime: string;
  isRead: boolean;
  categories: string[];
  attachments: FakeAttachment[];
  isDraft: boolean;
  internetMessageId: string;
  replyTo: string | null;
  /** The `Authentication-Results` headers of the message as stored, top to bottom (Microsoft's own first when it stamped one). */
  authenticationResults?: string[];
}

export interface FakeEvent {
  id: string;
  subject: string;
  body: string;
  location: string;
  start: string;
  end: string;
  isAllDay: boolean;
  attendees: { address: string; name?: string; response: string }[];
  organizer: string;
  isOrganizer: boolean;
  isCancelled: boolean;
  showAs: string;
  transactionId: string | null;
  joinUrl: string | null;
  originalStartTimeZone: string;
  calendarId: string;
  type: string;
}

export interface FakeDriveItem {
  id: string;
  name: string;
  parentId: string | null;
  folder: boolean;
  bytes: Buffer;
  mimeType: string;
  version: number;
  modified: string;
}

export interface FakeSheet {
  cells: Map<string, string | number | boolean>;
  /** Cells that Excel evaluated as formulas: the leak a raw write must never cause. */
  formulas: Map<string, string>;
  tables: { id: string; name: string; startCol: number; startRow: number; width: number; bodyRows: number }[];
}

export interface FakeAccountInit {
  email: string;
  name?: string;
  /** `personal` accounts live in the consumer tenant and have no free/busy, workbook or Teams. */
  kind?: 'work' | 'personal';
  tenantId?: string;
}

export interface Recorded {
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  bytes: number;
  /** The request body as text when it is JSON or a form, for assertions about shape. */
  json: unknown;
  form: Record<string, string> | null;
}

export const FAKE_HOSTS = { graph: 'graph.microsoft.com', login: 'login.microsoftonline.com', upload: 'upload.fake.example.test', download: 'download.fake.example.test' } as const;

const WELL_KNOWN = { inbox: 'Inbox', archive: 'Archive', drafts: 'Drafts', sentitems: 'Sent Items', deleteditems: 'Deleted Items', junkemail: 'Junk Email' } as const;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const GRAPH = `https://${FAKE_HOSTS.graph}/v1.0`;

export const respond = (status: number, body?: unknown, headers: Record<string, string> = {}): Response => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? headers : { ...JSON_HEADERS, ...headers } });
export const err = (status: number, code: string, headers?: Record<string, string>): Response => respond(status, { error: { code, message: `fake message that carries content: ${FakeGraph.CONTENT_MARKER}` } }, headers);

const a1col = (n: number): string => {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
};
const colNum = (s: string): number => [...s.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);

function tzOffsetMs(at: number, tz: string): number {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at));
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(at / 1000) * 1000;
}

/** A wall time in a zone to the UTC instant (ISO, `Z`). */
export function wallToUtc(dateTime: string, tz: string): string {
  const base = Date.parse(`${dateTime.replace(/\.\d+$/, '')}Z`);
  let utc = base - tzOffsetMs(base, tz);
  utc = base - tzOffsetMs(utc, tz);
  return new Date(utc).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export class FakeAccount {
  readonly messages: FakeMessage[] = [];
  readonly events: FakeEvent[] = [];
  readonly drive = new Map<string, FakeDriveItem>();
  readonly sheets = new Map<string, Map<string, FakeSheet>>();
  readonly masterCategories: string[] = [];
  readonly folders = new Map<string, { id: string; name: string; alias: string | null }>();
  readonly calendars: { id: string; name: string; isDefault: boolean; canEdit: boolean; owner: string }[] = [];
  /** Every mail this account sent: the proof that a retry did not send twice. */
  readonly sent: { to: string[]; subject: string; viaDraft: boolean }[] = [];
  /** Every invitation or cancellation Graph would have emailed. */
  readonly invitations: { eventId: string; kind: 'invite' | 'update' | 'cancel'; to: string[] }[] = [];
  readonly tenantId: string;
  readonly objectId: string;
  readonly kind: 'work' | 'personal';
  readonly email: string;
  readonly name: string;
  readonly uploadSessions = new Map<string, { target: { parentId: string | null; name: string; replaceId?: string; attachment?: { messageId: string; name: string; contentType: string } }; size: number; received: Buffer[] }>();
  private seq = 0;
  scopes: string[] = [];

  constructor(init: FakeAccountInit) {
    this.email = init.email;
    this.name = init.name ?? 'Person A';
    this.kind = init.kind ?? 'work';
    this.tenantId = this.kind === 'personal' ? CONSUMER_TENANT_ID : (init.tenantId ?? randomUUID());
    this.objectId = randomUUID();
    for (const [alias, name] of Object.entries(WELL_KNOWN)) this.folders.set(`F-${alias}`, { id: `F-${alias}`, name, alias });
    this.calendars.push({ id: 'CAL-default', name: 'Calendar', isDefault: true, canEdit: true, owner: this.email });
    this.drive.set('root-id', { id: 'root-id', name: 'root', parentId: null, folder: true, bytes: Buffer.alloc(0), mimeType: '', version: 1, modified: new Date().toISOString() });
  }

  newId(prefix: string): string {
    return `${prefix}-${this.objectId.slice(0, 4)}-${++this.seq}`;
  }

  folderByAlias(alias: string): string {
    return `F-${alias}`;
  }

  addMessage(m: Partial<FakeMessage> & { subject: string }): FakeMessage {
    const msg: FakeMessage = {
      id: m.id ?? this.newId('MSG'),
      conversationId: m.conversationId ?? this.newId('CONV'),
      folderId: m.folderId ?? 'F-inbox',
      from: m.from === undefined ? { address: 'person-b@example.test', name: 'Person B' } : m.from,
      to: m.to ?? [{ address: this.email, name: this.name }],
      cc: m.cc ?? [],
      bcc: m.bcc ?? [],
      subject: m.subject,
      text: m.text ?? 'Body text',
      html: m.html ?? null,
      receivedDateTime: m.receivedDateTime ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      isRead: m.isRead ?? false,
      categories: m.categories ?? [],
      attachments: m.attachments ?? [],
      isDraft: m.isDraft ?? false,
      internetMessageId: m.internetMessageId ?? `<${randomUUID()}@example.test>`,
      replyTo: m.replyTo ?? null,
      ...(m.authenticationResults ? { authenticationResults: m.authenticationResults } : {}),
    };
    this.messages.push(msg);
    return msg;
  }

  addEvent(e: Partial<FakeEvent> & { subject: string; start: string; end: string }): FakeEvent {
    const ev: FakeEvent = { id: e.id ?? this.newId('EVT'), body: '', location: '', isAllDay: false, attendees: [], organizer: this.email, isOrganizer: true, isCancelled: false, showAs: 'busy', transactionId: null, joinUrl: null, originalStartTimeZone: 'UTC', calendarId: 'CAL-default', type: 'singleInstance', ...e };
    this.events.push(ev);
    return ev;
  }

  addFile(f: Partial<FakeDriveItem> & { name: string }): FakeDriveItem {
    const item: FakeDriveItem = { id: f.id ?? this.newId('ITEM'), parentId: 'root-id', folder: false, bytes: Buffer.alloc(0), mimeType: 'application/octet-stream', version: 1, modified: new Date().toISOString(), ...f };
    this.drive.set(item.id, item);
    return item;
  }

  /** A workbook file with sheets of rows (strings or numbers) and, optionally, one table whose header is the first row. */
  addWorkbook(name: string, sheets: Record<string, { rows: (string | number)[][]; table?: boolean }>): FakeDriveItem {
    const file = this.addFile({ name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: Buffer.from('xlsx') });
    const map = new Map<string, FakeSheet>();
    for (const [sn, def] of Object.entries(sheets)) {
      const sheet: FakeSheet = { cells: new Map(), formulas: new Map(), tables: [] };
      def.rows.forEach((row, r) => row.forEach((v, c) => sheet.cells.set(`${r + 1},${c + 1}`, v)));
      if (def.table) sheet.tables.push({ id: this.newId('TBL'), name: 'Table1', startCol: 1, startRow: 1, width: def.rows[0]?.length ?? 1, bodyRows: Math.max(0, def.rows.length - 1) });
      map.set(sn, sheet);
    }
    this.sheets.set(file.id, map);
    return file;
  }

  sheet(fileId: string, name: string): FakeSheet {
    return this.sheets.get(fileId)!.get(name)!;
  }
}

interface Script {
  match: (r: Recorded) => boolean;
  /** Times left. */
  times: number;
  kind: 'respond' | 'after' | 'drop' | 'hang';
  response?: () => Response;
}

interface PendingCode {
  account: FakeAccount;
  scopes: string[];
  challenge: string;
  clientId: string;
}

export class FakeGraph {
  /** Text a real Graph error message could carry (a subject, an address, a file name): it must never reach a log, a span or an error. */
  static readonly CONTENT_MARKER = 'CONTENT-MARKER-7f3a';

  readonly requests: Recorded[] = [];
  readonly accounts: FakeAccount[] = [];
  private readonly byToken = new Map<string, FakeAccount>();
  private readonly refreshTokens = new Map<string, { account: FakeAccount; scopes: string[]; live: boolean }>();
  private readonly codes = new Map<string, PendingCode>();
  private readonly scripts: Script[] = [];
  /** Graph sometimes writes `/me/` as `/users('<id>')/` in next links. */
  rewriteNextLinks = false;
  /** Excel workbook calls answer this status for a personal account (it is not confirmed that they work). */
  workbookOnPersonal = 400;
  private tokenSeq = 0;
  clientSecret = 'fake-client-secret';
  /** The app registration the token endpoint accepts. */
  clientId = 'fake-client-id';
  /** Scopes added to the next consent, as Microsoft returns them. */
  scopePrefix = false;
  /** E50.11: tenants the identity platform does not know (AADSTS90002 at discovery and at the token endpoint). */
  readonly unknownTenants = new Set<string>();
  /** E50.11: how far the fake's clock (its `Date` header) is ahead of the server's. */
  clockSkewMs = 0;

  addAccount(init: FakeAccountInit): FakeAccount {
    const a = new FakeAccount(init);
    this.accounts.push(a);
    return a;
  }

  // ---- identity ----

  /** The owner consents: returns the authorization code the redirect would carry. */
  authorizeCode(account: FakeAccount, o: { scopes: string[]; codeChallenge: string }): string {
    const code = `code-${randomUUID()}`;
    this.codes.set(code, { account, scopes: o.scopes, challenge: o.codeChallenge, clientId: this.clientId });
    return code;
  }

  /**
   * What the browser does at Microsoft: the account consents to the URL's scopes (minus `deny`, the ones the owner unticked) and the
   * redirect carries the code and the `state`. Checks the URL the way Microsoft would: client id, PKCE method, a redirect URI.
   */
  consent(authorizeUrl: string, account: FakeAccount, o: { deny?: string[] } = {}): { code: string; state: string } {
    const p = new URL(authorizeUrl).searchParams;
    if (p.get('client_id') !== this.clientId || p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' || !p.get('redirect_uri')) throw new Error('Microsoft would refuse this authorization request');
    const scopes = (p.get('scope') ?? '').split(' ').filter((x) => x && !(o.deny ?? []).includes(x));
    return { code: this.authorizeCode(account, { scopes, codeChallenge: p.get('code_challenge') ?? '' }), state: p.get('state') ?? '' };
  }

  /** An access token for an account, as a refresh would give. */
  issue(account: FakeAccount, scopes: string[] = account.scopes): string {
    const token = `AT-${account.objectId.slice(0, 8)}-${++this.tokenSeq}`;
    this.byToken.set(token, account);
    account.scopes = scopes;
    return token;
  }

  /** Every token issued so far stops working (the 401 path). */
  expireAllTokens(): void {
    this.byToken.clear();
  }

  revokeGrant(refreshToken: string): void {
    const r = this.refreshTokens.get(refreshToken);
    if (r) r.live = false;
  }

  // ---- failures ----

  /** The next `times` requests that match answer 429 with `Retry-After`. */
  throttle(match: (r: Recorded) => boolean, times = 1, retryAfter: string | null = '1'): void {
    this.scripts.push({ match, times, kind: 'respond', response: () => err(429, 'ApplicationThrottled', retryAfter ? { 'retry-after': retryAfter } : {}) });
  }

  /** The next `times` requests that match answer with this status and are NOT processed. */
  fail(match: (r: Recorded) => boolean, status: number, code = 'InternalServerError', times = 1): void {
    this.scripts.push({ match, times, kind: 'respond', response: () => err(status, code) });
  }

  /** The request IS processed, then the answer is lost (a 504, or a dropped connection with `status` 0): the ambiguous failure. */
  failAfter(match: (r: Recorded) => boolean, status: number, times = 1): void {
    this.scripts.push({ match, times, kind: 'after', response: status === 0 ? undefined : () => err(status, 'GatewayTimeout') });
  }

  /** The connection drops before anything is processed. */
  drop(match: (r: Recorded) => boolean, times = 1): void {
    this.scripts.push({ match, times, kind: 'drop' });
  }

  /** Forgets every scripted failure that has not happened yet. */
  clearScripts(): void {
    this.scripts.length = 0;
  }

  /** The next matching request never answers (until its signal aborts): for Stop and timeouts. */
  hang(match: (r: Recorded) => boolean, times = 1): void {
    this.scripts.push({ match, times, kind: 'hang' });
  }

  /** A hand-written answer for the next matching request. */
  answer(match: (r: Recorded) => boolean, response: () => Response, times = 1): void {
    this.scripts.push({ match, times, kind: 'respond', response });
  }

  calls(filter?: (r: Recorded) => boolean): Recorded[] {
    return filter ? this.requests.filter(filter) : this.requests;
  }

  // ---- the fetch ----

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const raw = init?.body === undefined || init.body === null ? null : typeof init.body === 'string' ? init.body : Buffer.from(init.body as Uint8Array);
    const text = typeof raw === 'string' ? raw : null;
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (query[k] = v));
    const ct = headers['content-type'] ?? '';
    const rec: Recorded = {
      method: (init?.method ?? 'GET').toUpperCase(),
      host: url.host,
      path: decodeURIComponent(url.pathname).replace(/^\/v1\.0/, ''),
      query,
      headers,
      bytes: raw === null ? 0 : raw.length,
      json: text !== null && ct.includes('json') ? safeJson(text) : null,
      form: text !== null && ct.includes('x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(text)) : null,
    };
    this.requests.push(rec);
    if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const script = this.scripts.find((s) => s.times > 0 && s.match(rec));
    if (script) {
      script.times--;
      if (script.kind === 'drop') throw new TypeError('fetch failed');
      if (script.kind === 'hang') {
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(Object.assign(new Error('aborted'), { name: init?.signal?.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError' }));
          if (init?.signal?.aborted) abort();
          init?.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      if (script.kind === 'respond') return script.response!();
    }
    const res = this.dated(await this.route(url, rec, raw));
    if (script?.kind === 'after') {
      if (script.response) return script.response();
      throw new TypeError('fetch failed');
    }
    return res;
  };

  /** Every answer carries a `Date` header, as Microsoft's do. */
  private dated(res: Response): Response {
    try {
      if (!res.headers.has('date')) res.headers.set('date', new Date(Date.now() + this.clockSkewMs).toUTCString());
    } catch {
      // an immutable header list (a redirect): left as it is
    }
    return res;
  }

  private account(rec: Recorded): FakeAccount | Response {
    const m = /^Bearer (.+)$/.exec(rec.headers.authorization ?? '');
    const a = m ? this.byToken.get(m[1]!) : undefined;
    return a ?? err(401, 'InvalidAuthenticationToken');
  }

  private async route(url: URL, rec: Recorded, raw: string | Buffer | null): Promise<Response> {
    if (url.host === FAKE_HOSTS.login) return this.login(url, rec);
    if (url.host === FAKE_HOSTS.upload) return this.uploadHost(url, rec, raw);
    if (url.host === FAKE_HOSTS.download) return this.downloadHost(url);
    if (url.host !== FAKE_HOSTS.graph) throw new TypeError('fetch failed');
    const who = this.account(rec);
    if (who instanceof Response) return who;
    return new GraphRouter(this, who).handle(rec, raw, url);
  }

  // ---- login.microsoftonline.com ----

  private login(url: URL, rec: Recorded): Response {
    const tenant = url.pathname.split('/')[1] ?? '';
    const noTenant = (): Response => respond(400, { error: 'invalid_tenant', error_description: `AADSTS90002: fake description with ${FakeGraph.CONTENT_MARKER}`, error_codes: [90002] });
    if (/^\/[^/]+\/v2\.0\/\.well-known\/openid-configuration$/.test(url.pathname) && rec.method === 'GET') {
      if (this.unknownTenants.has(tenant)) return noTenant();
      return respond(200, { issuer: `https://${FAKE_HOSTS.login}/{tenantid}/v2.0`, authorization_endpoint: `https://${FAKE_HOSTS.login}/${tenant}/oauth2/v2.0/authorize`, token_endpoint: `https://${FAKE_HOSTS.login}/${tenant}/oauth2/v2.0/token` });
    }
    if (!/\/oauth2\/v2\.0\/token$/.test(url.pathname) || rec.method !== 'POST' || !rec.form) return err(404, 'NotFound');
    if (this.unknownTenants.has(tenant)) return noTenant();
    const f = rec.form;
    const bad = (error: string, codes: number[] = []): Response => respond(400, { error, error_description: `AADSTS${codes[0] ?? 0}: fake description with ${FakeGraph.CONTENT_MARKER}`, error_codes: codes });
    if (f.client_id !== this.clientId || f.client_secret !== this.clientSecret) return respond(401, { error: 'invalid_client', error_description: 'AADSTS7000215: fake', error_codes: [7000215] });
    if (f.grant_type === 'authorization_code') {
      const p = this.codes.get(f.code ?? '');
      this.codes.delete(f.code ?? '');
      if (!p) return bad('invalid_grant', [70000]);
      if (!f.code_verifier || codeChallengeS256(f.code_verifier) !== p.challenge) return bad('invalid_grant', [70000]);
      return this.tokens(p.account, p.scopes, true);
    }
    if (f.grant_type === 'refresh_token') {
      const r = this.refreshTokens.get(f.refresh_token ?? '');
      if (!r || !r.live) return bad('invalid_grant', [70008]);
      r.live = false; // rotation: the presented token is retired
      return this.tokens(r.account, r.scopes, false);
    }
    return bad('unsupported_grant_type');
  }

  private tokens(account: FakeAccount, scopes: string[], withIdToken: boolean): Response {
    const access = this.issue(account, scopes);
    const refresh = `RT-${randomUUID()}`;
    this.refreshTokens.set(refresh, { account, scopes, live: true });
    const claims = { aud: this.clientId, tid: account.tenantId, oid: account.objectId, preferred_username: account.email, name: account.name };
    const idToken = `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
    const shown = this.scopePrefix ? scopes.map((s) => (/^[A-Z]/.test(s) && s !== 'User.Read' ? `https://graph.microsoft.com/${s}` : s)) : scopes;
    return respond(200, { token_type: 'Bearer', scope: shown.join(' '), expires_in: 3599, access_token: access, refresh_token: refresh, ...(withIdToken ? { id_token: idToken } : {}) });
  }

  // ---- upload and download hosts ----

  private uploadHost(url: URL, rec: Recorded, raw: string | Buffer | null): Response {
    const id = url.pathname.split('/').pop() ?? '';
    const found = this.accounts.map((a) => ({ a, s: a.uploadSessions.get(id) })).find((x) => x.s);
    if (!found?.s || rec.method !== 'PUT' || !Buffer.isBuffer(raw)) return err(404, 'itemNotFound');
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(rec.headers['content-range'] ?? '');
    if (!range) return err(400, 'invalidRange');
    const { a, s } = found;
    s.received.push(raw);
    const got = s.received.reduce((n, b) => n + b.length, 0);
    if (got < Number(range[3])) return respond(202, { expirationDateTime: '2099-01-01T00:00:00Z', nextExpectedRanges: [`${got}-`] });
    const bytes = Buffer.concat(s.received);
    a.uploadSessions.delete(id);
    if (s.target.attachment) {
      const msg = a.messages.find((mm) => mm.id === s.target.attachment!.messageId);
      msg?.attachments.push({ id: a.newId('ATT'), name: s.target.attachment.name, contentType: s.target.attachment.contentType, bytes });
      return respond(201, {});
    }
    const item = s.target.replaceId ? a.drive.get(s.target.replaceId)! : a.addFile({ name: s.target.name, parentId: s.target.parentId });
    item.bytes = bytes;
    item.version++;
    item.modified = new Date().toISOString();
    return respond(201, driveItemJson(item));
  }

  private downloadHost(url: URL): Response {
    const id = url.pathname.split('/').pop() ?? '';
    for (const a of this.accounts) {
      const item = a.drive.get(id);
      if (item) return new Response(new Uint8Array(item.bytes), { status: 200, headers: { 'content-type': item.mimeType || 'application/octet-stream' } });
    }
    return err(404, 'itemNotFound');
  }

  /** What an `.xlsx` generated by the provider holds, as a workbook the Excel endpoints can read. */
  static registerXlsx(a: FakeAccount, item: FakeDriveItem): void {
    const entries = readZip(item.bytes);
    const sheet = entries.find((e) => e.name === 'xl/worksheets/sheet1.xml')?.data.toString('utf8') ?? '';
    const cells = new Map<string, string | number | boolean>();
    for (const m of sheet.matchAll(/<c r="([A-Z]+)(\d+)"[^>]*><is><t[^>]*>([\s\S]*?)<\/t><\/is><\/c>/g)) cells.set(`${m[2]},${colNum(m[1]!)}`, m[3]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'));
    a.sheets.set(item.id, new Map([['Sheet1', { cells, formulas: new Map(), tables: [] }]]));
  }

  /** The text of a `.docx` the provider generated or appended to. */
  static docxText(item: FakeDriveItem): string {
    return docxToText(item.bytes);
  }

  nextLink(path: string, query: Record<string, string>, account: FakeAccount): string {
    const p = this.rewriteNextLinks ? path.replace(/^\/me\//, `/users('${account.objectId}')/`) : path;
    return `${GRAPH}${p}?${new URLSearchParams(query).toString()}`;
  }
}

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

export const driveItemJson = (i: FakeDriveItem): G => ({
  id: i.id,
  name: i.name,
  size: i.bytes.length,
  webUrl: `https://files.example.test/${i.id}`,
  lastModifiedDateTime: i.modified,
  eTag: `"etag-${i.id}-${i.version}"`,
  parentReference: i.parentId ? { id: i.parentId } : undefined,
  ...(i.folder ? { folder: { childCount: 0 } } : { file: { mimeType: i.mimeType } }),
});

import { GraphRouter } from './fake-graph.router';
export { a1col, colNum };
