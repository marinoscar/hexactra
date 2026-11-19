// The Google adapter against the in-process fake Google endpoints (E39.3, #601): request shape, response mapping, paging,
// truncation, every typed error, backoff, abort, the capability gate, and tokens that never cross between two accounts.
import { CapabilityError, type CapabilityErrorCode } from '../src/connections/capabilities';
import { CapabilityHub } from '../src/connections/capability-hub';
import { CapabilityProviderRegistry } from '../src/connections/capability-provider.registry';
import { CAPABILITIES, type Capability } from '../src/connections/connections.constants';
import { GoogleCapabilityProvider } from '../src/connections/google/google.provider';
import { GoogleHttp, type TokenSource } from '../src/connections/google/google-http';
import { SCOPE } from '../src/connections/google/google.scopes';
import { FakeGoogle, type FakeGoogleAccount } from '../src/connections/google/testing';
import { InMemoryConnections } from '../src/connections/testing';
import type { CapabilityLimits } from '../src/connections/capabilities';

interface World {
  fake: FakeGoogle;
  hub: CapabilityHub;
  http: GoogleHttp;
  sleeps: number[];
  refreshes: string[];
  connections: InMemoryConnections;
  /** A connection to a new Google account. */
  connect(opts?: { email?: string; capabilities?: Capability[]; granted?: Capability[]; scopes?: string[]; label?: string }): { id: string; userId: string; account: FakeGoogleAccount; ctx: (signal?: AbortSignal) => { connectionId: string; userId: string; signal?: AbortSignal } };
}

function world(limits?: Partial<CapabilityLimits>, httpOpts: { maxTries?: number; concurrency?: number; realSleep?: boolean } = {}): World {
  const fake = new FakeGoogle();
  const sleeps: number[] = [];
  const refreshes: string[] = [];
  const connections = new InMemoryConnections();
  const accountOf = new Map<string, FakeGoogleAccount>();
  const tokens: TokenSource = {
    // What the real token service does: this connection's token only; a forced refresh asks Google for a new one.
    getAccessToken: async (connectionId, _userId, opts) => {
      const a = accountOf.get(connectionId)!;
      if (opts?.forceRefresh) {
        refreshes.push(connectionId);
        a.accessToken = `fake-access-refreshed-${refreshes.length}`;
      }
      return a.accessToken;
    },
  };
  const http = new GoogleHttp(fake, undefined, { sleep: httpOpts.realSleep ? undefined : async (ms) => void sleeps.push(ms), random: () => 0.5, maxTries: httpOpts.maxTries, concurrency: httpOpts.concurrency });
  const registry = new CapabilityProviderRegistry();
  registry.register(new GoogleCapabilityProvider(http, tokens));
  const hub = new CapabilityHub({ lookup: connections.lookup, providers: registry, limits });
  return {
    fake,
    hub,
    http,
    sleeps,
    refreshes,
    connections,
    connect: (opts = {}) => {
      const account = fake.addAccount({ email: opts.email, scopes: opts.scopes });
      const row = connections.add({ capabilities: opts.capabilities ?? [...CAPABILITIES], granted: opts.granted, label: opts.label ?? account.email, accountEmail: account.email });
      accountOf.set(row.id, account);
      return { id: row.id, userId: row.userId, account, ctx: (signal) => ({ connectionId: row.id, userId: row.userId, signal }) };
    },
  };
}

const fail = async (p: Promise<unknown>): Promise<CapabilityError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof CapabilityError) return e;
    throw e;
  }
  throw new Error('expected a CapabilityError');
};
const code = async (p: Promise<unknown>): Promise<CapabilityErrorCode | 'ok'> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof CapabilityError ? e.code : (`other:${(e as Error).message}` as never);
  }
};

describe('Gmail', () => {
  it('searches with a structured query: request shape, mapping, paging', async () => {
    const w = world();
    const c = w.connect();
    for (let i = 0; i < 5; i++) c.account.addMessage({ subject: `Invoice ${i}`, from: 'Person B <person-b@example.test>', date: new Date(Date.UTC(2026, 2, 10 + i)), attachments: i === 0 ? [{ filename: 'a.pdf', bytes: Buffer.from('x') }] : [] });
    c.account.addMessage({ subject: 'Other', from: 'person-c@example.test' });
    const mail = w.hub.mail(c.ctx());
    const p1 = await mail.search({ from: 'person-b@example.test', subject: 'Invoice', pageSize: 2 });
    const list = w.fake.requestsTo('GET gmail.googleapis.com/gmail/v1/users/me/messages$')[0]!;
    expect(list.query.q).toEqual(['from:"person-b@example.test" subject:"Invoice"']);
    expect(list.query.maxResults).toEqual(['2']);
    expect(list.bearer).toBe(c.account.accessToken);
    expect(p1.items).toHaveLength(2);
    expect(p1.items[0]).toMatchObject({ subject: 'Invoice 4', from: { address: 'person-b@example.test', name: 'Person B' }, to: [{ address: c.account.email }], unread: true, labels: ['INBOX', 'UNREAD'], hasAttachments: false });
    expect(p1.items[0]!.date).toMatch(/^2026-03-14T/);
    expect(p1.nextPageToken).toBe('2');
    const p2 = await mail.search({ from: 'person-b@example.test', subject: 'Invoice', pageSize: 2, pageToken: p1.nextPageToken! });
    expect(p2.items.map((m) => m.subject)).toEqual(['Invoice 2', 'Invoice 1']);
    const p3 = await mail.search({ from: 'person-b@example.test', subject: 'Invoice', pageSize: 2, pageToken: p2.nextPageToken! });
    expect(p3.items.map((m) => m.subject)).toEqual(['Invoice 0']);
    expect(p3.items[0]!.hasAttachments).toBe(true);
    expect(p3.nextPageToken).toBeNull();
    expect((await mail.search({ label: 'INBOX', unread: true, hasAttachment: true })).items).toHaveLength(1);
    expect(w.fake.requestsTo('GET gmail.googleapis.com/gmail/v1/users/me/messages$').at(-1)!.query.labelIds).toEqual(['INBOX']);
  });

  it('a hostile value is text: it matches nothing and widens nothing', async () => {
    const w = world();
    const c = w.connect();
    c.account.addMessage({ subject: 'Hello', from: 'person-b@example.test' });
    const r = await w.hub.mail(c.ctx()).search({ text: 'x" OR in:anywhere' });
    expect(r.items).toHaveLength(0);
    expect(w.fake.requests.at(-1)!.query.q).toEqual(['"x" "OR" "in:anywhere"']);
  });

  it('reads a message: text preferred, HTML reduced to text, html on request, attachments listed, truncation marked', async () => {
    const w = world({ bodyChars: 50 });
    const c = w.connect();
    const both = c.account.addMessage({ text: 'Plain version', html: '<p>HTML version</p>', cc: 'Person C <person-c@example.test>', attachments: [{ filename: 'Scan é.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF') }] });
    const htmlOnly = c.account.addMessage({ text: undefined, html: '<div>Only <b>html</b></div><script>x()</script>' });
    const long = c.account.addMessage({ text: 'y'.repeat(200) });
    const mail = w.hub.mail(c.ctx());
    const a = await mail.get(both.id, { body: 'text' });
    expect(a).toMatchObject({ text: 'Plain version', html: null, truncated: false, cc: [{ address: 'person-c@example.test', name: 'Person C' }], internetMessageId: `<${both.id}@example.test>` });
    expect(a.attachments).toEqual([{ id: expect.any(String), filename: 'Scan é.pdf', contentType: 'application/pdf', size: 4 }]);
    expect((await mail.get(htmlOnly.id, { body: 'text' })).text).toBe('Only html');
    expect((await mail.get(both.id, { body: 'html' }))).toMatchObject({ html: '<p>HTML version</p>', text: null });
    expect((await mail.get(both.id, { body: 'none' }))).toMatchObject({ html: null, text: null });
    const t = await mail.get(long.id, { body: 'text' });
    expect(t.text).toHaveLength(50);
    expect(t.truncated).toBe(true);
    expect(w.fake.requestsTo('GET gmail.googleapis.com/gmail/v1/users/me/messages/[^/]+$').at(-1)!.query.format).toEqual(['full']);
  });

  it('reports the receiving server\'s sender check: pass, fail, none, a spoofed From, and a forged header below Gmail\'s own (E39.8)', async () => {
    const w = world();
    const c = w.connect();
    const GMAIL = 'mx.google.com;';
    const pass = c.account.addMessage({ from: 'Billing <billing@example.test>', authenticationResults: `${GMAIL} dkim=pass header.i=@example.test header.s=s1; spf=pass smtp.mailfrom=billing@example.test; dmarc=pass (p=NONE) header.from=example.test` });
    const fail = c.account.addMessage({ from: 'Billing <billing@example.test>', authenticationResults: `${GMAIL} spf=fail smtp.mailfrom=billing@example.test; dkim=none; dmarc=fail header.from=example.test` });
    const none = c.account.addMessage({ from: 'Billing <billing@example.test>' });
    // The From says billing@example.test, but the signature and the envelope are the attacker's own domain.
    const spoof = c.account.addMessage({ from: 'Billing <billing@example.test>', authenticationResults: `${GMAIL} dkim=pass header.d=evil.test; spf=pass smtp.mailfrom=x@evil.test; dmarc=none` });
    // The sender wrote a passing header of their own: it sits below Gmail's, which says fail.
    const forged = c.account.addMessage({ from: 'Billing <billing@example.test>', authenticationResults: [`${GMAIL} dmarc=fail header.from=example.test`, 'attacker.test; dmarc=pass header.from=example.test'] });
    // A header only the sender wrote, with another server's name on top, is not Gmail's word.
    const foreign = c.account.addMessage({ from: 'Billing <billing@example.test>', authenticationResults: 'attacker.test; dmarc=pass header.from=example.test' });
    const mail = w.hub.mail(c.ctx());
    const auth = async (id: string) => (await mail.get(id, { body: 'none' })).senderAuth;
    expect(await auth(pass.id)).toBe('pass');
    expect(await auth(fail.id)).toBe('fail');
    expect(await auth(none.id)).toBe('unknown');
    expect(await auth(spoof.id)).toBe('unknown');
    expect(await auth(forged.id)).toBe('fail');
    expect(await auth(foreign.id)).toBe('unknown');
    // A search carries it on every summary too.
    const found = await mail.search({ from: 'billing@example.test' });
    expect(Object.fromEntries(found.items.map((m) => [m.id, m.senderAuth]))).toEqual({ [pass.id]: 'pass', [fail.id]: 'fail', [none.id]: 'unknown', [spoof.id]: 'unknown', [forged.id]: 'fail', [foreign.id]: 'unknown' });
  });

  it('downloads an attachment and refuses one over the cap before fetching it', async () => {
    const w = world({ attachmentBytes: 1000 });
    const c = w.connect();
    const m = c.account.addMessage({ attachments: [{ filename: 'small.bin', bytes: Buffer.alloc(100, 7) }, { filename: 'big.bin', bytes: Buffer.alloc(2000, 1) }] });
    const info = (await w.hub.mail(c.ctx()).get(m.id, { body: 'none' })).attachments;
    const small = await w.hub.mail(c.ctx()).getAttachment(m.id, info[0]!.id);
    expect(small).toMatchObject({ filename: 'small.bin', size: 100 });
    expect(small.bytes.equals(Buffer.alloc(100, 7))).toBe(true);
    const before = w.fake.requestsTo('/attachments/').length;
    expect(await code(w.hub.mail(c.ctx()).getAttachment(m.id, info[1]!.id))).toBe('TOO_LARGE');
    expect(w.fake.requestsTo('/attachments/').length).toBe(before); // the bytes were never fetched
    expect(await code(w.hub.mail(c.ctx()).getAttachment(m.id, 'nope'))).toBe('NOT_FOUND');
  });

  it('sends a composed message as the account, with the reply threaded', async () => {
    const w = world();
    const c = w.connect();
    const orig = c.account.addMessage({ subject: 'Question', messageId: '<q1@example.test>', references: '<q0@example.test>', threadId: 'thread-9' });
    const sent = await w.hub.mail(c.ctx()).send({ to: [{ address: 'person-b@example.test', name: 'Person B' }], cc: [{ address: 'person-c@example.test' }], subject: 'Re: Réponse', text: 'Thanks', html: '<p>Thanks</p>', attachments: [{ filename: 'a.txt', contentType: 'text/plain', bytes: Buffer.from('att') }], inReplyTo: orig.id });
    const post = w.fake.requestsTo('POST gmail.googleapis.com/gmail/v1/users/me/messages/send')[0]!;
    expect(Object.keys(post.json as object).sort()).toEqual(['raw', 'threadId']);
    expect((post.json as { threadId: string }).threadId).toBe('thread-9');
    const s = c.account.sent[0]!;
    expect(sent.messageId).toBe(s.id);
    expect(s.headers.from).toEqual([c.account.email]);
    expect(s.headers.to![0]).toBe('Person B <person-b@example.test>');
    expect(s.headers['in-reply-to']).toEqual(['<q1@example.test>']);
    expect(s.headers.references).toEqual(['<q0@example.test> <q1@example.test>']);
    expect(s.text).toBe('Thanks');
    expect(s.html).toBe('<p>Thanks</p>');
    expect(s.attachments).toEqual([{ filename: 'a.txt', contentType: 'text/plain', bytes: Buffer.from('att') }]);
  });

  it('creates a draft, sends it, and changes labels, read state and the inbox', async () => {
    const w = world();
    const c = w.connect();
    const { draftId } = await w.hub.mail(c.ctx()).createDraft({ to: [{ address: 'person-b@example.test' }], subject: 'Draft', text: 'x' });
    expect(c.account.drafts.has(draftId)).toBe(true);
    expect(c.account.sent).toHaveLength(0);
    await w.hub.mail(c.ctx()).send({ draftId });
    expect(c.account.sent).toHaveLength(1);
    const m = c.account.addMessage({});
    await w.hub.mail(c.ctx()).modify(m.id, { archive: true, read: true, addLabels: ['Label_1'] });
    expect(m.labelIds.sort()).toEqual(['Label_1']);
    expect(w.fake.requestsTo('POST .*/modify')[0]!.json).toEqual({ addLabelIds: ['Label_1'], removeLabelIds: ['UNREAD', 'INBOX'] });
    const before = w.fake.requests.length;
    await w.hub.mail(c.ctx()).modify(m.id, {});
    expect(w.fake.requests.length).toBe(before); // nothing to change, no request
    expect((await w.hub.mail(c.ctx()).listLabels()).find((l) => l.id === 'Label_1')).toEqual({ id: 'Label_1', name: 'Receipts', kind: 'user' });
  });

  it('never sends as an alias: From is the connection address whatever the caller supplies', async () => {
    const w = world();
    const c = w.connect();
    // `from` is not part of the contract: an extra field is dropped by validation, never reaches the composer
    await w.hub.mail(c.ctx()).send({ to: [{ address: 'person-b@example.test' }], subject: 's', text: 't', from: 'boss@example.test' } as never);
    expect(c.account.sent[0]!.headers.from).toEqual([c.account.email]);
  });
});

describe('Calendar', () => {
  const ev = { title: 'Lunch', start: '2026-03-02T12:00:00-05:00', end: '2026-03-02T13:00:00-05:00' };

  it('lists calendars and events with paging and explicit offsets', async () => {
    const w = world();
    const c = w.connect();
    const cal = w.hub.calendar(c.ctx());
    expect(await cal.listCalendars()).toEqual([{ id: 'primary', name: 'Person A', primary: true, timeZone: 'UTC', accessRole: 'owner' }]);
    for (let i = 0; i < 3; i++) await cal.createEvent({ ...ev, title: `Event ${i}`, start: `2026-03-0${i + 2}T12:00:00-05:00`, end: `2026-03-0${i + 2}T13:00:00-05:00` });
    const p1 = await cal.listEvents({ from: '2026-03-01T00:00:00Z', to: '2026-03-31T00:00:00Z', pageSize: 2 });
    const req = w.fake.requestsTo('GET www.googleapis.com/calendar/v3/calendars/primary/events$')[0]!;
    expect(req.query).toMatchObject({ timeMin: ['2026-03-01T00:00:00Z'], timeMax: ['2026-03-31T00:00:00Z'], singleEvents: ['true'], orderBy: ['startTime'], maxResults: ['2'] });
    expect(p1.items).toHaveLength(2);
    expect(p1.items[0]).toMatchObject({ title: 'Event 0', start: '2026-03-02T12:00:00-05:00', allDay: false, calendarId: 'primary', status: 'confirmed' });
    expect(p1.nextPageToken).toBe('2');
    const p2 = await cal.listEvents({ from: '2026-03-01T00:00:00Z', to: '2026-03-31T00:00:00Z', pageSize: 2, pageToken: '2' });
    expect(p2.items).toHaveLength(1);
    expect((await cal.listEvents({ from: '2026-03-01T00:00:00Z', to: '2026-03-31T00:00:00Z', text: 'event 1' })).items.map((e) => e.title)).toEqual(['Event 1']);
  });

  it('reports free and busy blocks', async () => {
    const w = world();
    const c = w.connect();
    c.account.busy = [{ calendarId: 'primary', start: '2026-03-02T15:00:00Z', end: '2026-03-02T16:00:00Z' }];
    expect(await w.hub.calendar(c.ctx()).freeBusy({ from: '2026-03-02T00:00:00Z', to: '2026-03-03T00:00:00Z' })).toEqual([{ calendarId: 'primary', start: '2026-03-02T15:00:00Z', end: '2026-03-02T16:00:00Z' }]);
    expect((w.fake.requestsTo('freeBusy')[0]!.json as { items: unknown }).items).toEqual([{ id: 'primary' }]);
  });

  it('does not notify attendees unless asked: sendUpdates is none by default on create, update and delete', async () => {
    const w = world();
    const c = w.connect();
    const cal = w.hub.calendar(c.ctx());
    const created = await cal.createEvent({ ...ev, attendees: [{ address: 'person-b@example.test', name: 'Person B' }] });
    expect(w.fake.requestsTo('POST .*/events$')[0]!.query.sendUpdates).toEqual(['none']);
    expect(created.attendees).toEqual([{ address: 'person-b@example.test', name: 'Person B', response: 'needsAction', organizer: false }]);
    expect(w.fake.requestsTo('POST .*/events$')[0]!.json).toMatchObject({ attendees: [{ email: 'person-b@example.test', displayName: 'Person B' }] });
    await cal.updateEvent(created.id, { title: 'Brunch' });
    expect(w.fake.requestsTo('PATCH')[0]!.query.sendUpdates).toEqual(['none']);
    await cal.updateEvent(created.id, { location: 'Room 1', notifyAttendees: true });
    expect(w.fake.requestsTo('PATCH')[1]!.query.sendUpdates).toEqual(['all']);
    await cal.deleteEvent(created.id, { notifyAttendees: false });
    expect(w.fake.requestsTo('DELETE')[0]!.query.sendUpdates).toEqual(['none']);
    const again = await cal.createEvent({ ...ev, notifyAttendees: true, conference: true });
    expect(w.fake.requestsTo('POST .*/events$')[1]!.query).toMatchObject({ sendUpdates: ['all'], conferenceDataVersion: ['1'] });
    expect(again.conferenceUrl).toBe('https://meet.example.test/fake');
  });

  it('creates an event with a client id so a retry after a lost answer finds the same event', async () => {
    const w = world();
    const c = w.connect();
    const cal = w.hub.calendar(c.ctx());
    w.fake.failNext('POST .*/events$', { status: 503 });
    const e1 = await cal.createEvent({ ...ev, idempotencyKey: 'delivery-0000001' });
    expect(w.fake.requestsTo('POST .*/events$')).toHaveLength(2); // retried once after the 503
    expect(c.account.events).toHaveLength(1);
    const ids = w.fake.requestsTo('POST .*/events$').map((r) => (r.json as { id: string }).id);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toMatch(/^[0-9a-v]{5,1024}$/);
    // the same key again: Google answers 409, the adapter returns the existing event
    const e2 = await cal.createEvent({ ...ev, idempotencyKey: 'delivery-0000001' });
    expect(e2.id).toBe(e1.id);
    expect(c.account.events).toHaveLength(1);
  });

  it('treats deleting an event that is already gone as done, and an unknown event as NOT_FOUND', async () => {
    const w = world();
    const c = w.connect();
    const cal = w.hub.calendar(c.ctx());
    const e = await cal.createEvent(ev);
    await cal.deleteEvent(e.id, { notifyAttendees: false });
    await cal.deleteEvent(e.id, { notifyAttendees: false });
    expect(await code(cal.deleteEvent('never-existed', { notifyAttendees: false }))).toBe('NOT_FOUND');
    expect(await code(cal.updateEvent('never-existed', { title: 'x' }))).toBe('NOT_FOUND');
  });

  it('maps all-day events', async () => {
    const w = world();
    const c = w.connect();
    const e = await w.hub.calendar(c.ctx()).createEvent({ title: 'Holiday', start: '2026-03-02', end: '2026-03-03' });
    expect(e).toMatchObject({ allDay: true, start: '2026-03-02', end: '2026-03-03' });
    expect(w.fake.requestsTo('POST .*/events$')[0]!.json).toMatchObject({ start: { date: '2026-03-02' }, end: { date: '2026-03-03' } });
  });
});

describe('Drive, Docs and Sheets', () => {
  it('searches files with an escaped query, gets one, and keeps to files the app created or the owner picked', async () => {
    const w = world();
    const c = w.connect();
    const docs = w.hub.documents(c.ctx());
    const folder = await docs.createFolder({ name: 'Hexactra' });
    const doc = await docs.createDocument({ title: "Owner's notes", text: 'x', folderId: folder.id });
    c.account.addDoc('Hidden', 'secret', { visible: false });
    expect(folder).toMatchObject({ kind: 'folder', name: 'Hexactra' });
    expect(doc).toMatchObject({ kind: 'document', parentId: folder.id });
    const found = await docs.searchFiles({ text: "owner's", type: 'document', folderId: folder.id });
    expect(found.items.map((f) => f.id)).toEqual([doc.id]);
    const q = w.fake.requestsTo('GET www.googleapis.com/drive/v3/files$').at(-1)!.query.q![0]!;
    expect(q).toBe(`trashed = false and fullText contains 'owner\\'s' and mimeType = 'application/vnd.google-apps.document' and '${folder.id}' in parents`);
    expect((await docs.searchFiles({ text: "x' or name contains '" })).items).toEqual([]); // cannot add a clause
    expect((await docs.searchFiles({})).items.map((f) => f.name).sort()).toEqual(['Hexactra', "Owner's notes"]);
    expect((await docs.getFile(doc.id)).id).toBe(doc.id);
    const hidden = c.account.files.find((f) => f.name === 'Hidden')!;
    const e = await fail(docs.registerPickedFile(hidden.id));
    expect(e).toMatchObject({ code: 'NOT_FOUND', details: { reason: 'NOT_PICKED_OR_MISSING' } });
    c.account.pick(hidden.id);
    expect((await docs.registerPickedFile(hidden.id)).name).toBe('Hidden');
  });

  it('accepts a pasted link where an id is expected', async () => {
    const w = world();
    const c = w.connect();
    const id = c.account.addDoc('Linked', 'hello linked doc');
    expect((await w.hub.documents(c.ctx()).readDocument(`https://docs.google.com/document/d/${id}/edit?usp=sharing`)).text).toBe('hello linked doc\n');
  });

  it('reads a document as flattened text and marks truncation', async () => {
    const w = world({ bodyChars: 20 });
    const c = w.connect();
    const short = c.account.addDoc('Short', 'one\ntwo');
    const long = c.account.addDoc('Long', 'z'.repeat(100));
    expect(await w.hub.documents(c.ctx()).readDocument(short)).toEqual({ text: 'one\ntwo\n', truncated: false });
    const t = await w.hub.documents(c.ctx()).readDocument(long);
    expect(t.text).toHaveLength(20);
    expect(t.truncated).toBe(true);
    expect(await code(w.hub.documents(c.ctx()).readDocument('does-not-exist-123'))).toBe('NOT_FOUND');
  });

  it('creates and appends to a document', async () => {
    const w = world();
    const c = w.connect();
    const docs = w.hub.documents(c.ctx());
    const d = await docs.createDocument({ title: 'Report', text: 'First line\n' });
    await docs.appendToDocument(d.id, 'Second line\n');
    expect(c.account.docs.get(d.id)).toBe('First line\nSecond line\n');
    expect(w.fake.requestsTo('batchUpdate')[0]!.json).toEqual({ requests: [{ insertText: { text: 'First line\n', endOfSegmentLocation: {} } }] });
  });

  it('appends rows RAW: a formula-looking cell arrives as text', async () => {
    const w = world();
    const c = w.connect();
    const docs = w.hub.documents(c.ctx());
    const sheet = await docs.createSpreadsheet({ title: 'Payments', headers: ['Date', 'Amount', 'Note'] });
    const r = await docs.appendRows(sheet.id, undefined, [['2026-03-02', 1250.5, '=HYPERLINK("https://attacker.example.test","click")'], ['2026-03-03', true, null]]);
    expect(r).toEqual({ updatedRange: 'Sheet1!A2:C3', ambiguous: false });
    const req = w.fake.requestsTo('POST .*:append')[0]!;
    expect(req.query).toMatchObject({ valueInputOption: ['RAW'], insertDataOption: ['INSERT_ROWS'] });
    expect(req.json).toEqual({ majorDimension: 'ROWS', values: [['2026-03-02', 1250.5, '=HYPERLINK("https://attacker.example.test","click")'], ['2026-03-03', true, null]] });
    const read = await docs.readSheet(sheet.id, {});
    expect(read.values[1]![2]).toBe('=HYPERLINK("https://attacker.example.test","click")');
    expect(read.values[0]).toEqual(['Date', 'Amount', 'Note']);
    expect(w.fake.requestsTo('PUT .*values/A1')[0]!.query.valueInputOption).toEqual(['RAW']);
    expect((await docs.appendRows(sheet.id, 'Sheet1', [['x']])).updatedRange).toBe('Sheet1!A4:A4');
    expect(w.fake.requestsTo('POST .*:append').at(-1)!.path).toContain("'Sheet1'!A1");
  });

  it('reads a sheet with the cell cap and marks truncation', async () => {
    const w = world({ sheetCells: 10 });
    const c = w.connect();
    const id = c.account.addSheet('Data');
    c.account.sheets.get(id)!.set('Sheet1', Array.from({ length: 6 }, (_, i) => [i, `r${i}`, true]));
    const r = await w.hub.documents(c.ctx()).readSheet(id, { sheet: 'Sheet1' });
    expect(r.truncated).toBe(true);
    expect(r.values.flat()).toHaveLength(10);
    expect(w.fake.requestsTo('GET .*/values/')[0]!.path).toContain(encodeURIComponent("'Sheet1'!A1:ZZ5000"));
    const small = world({ sheetCells: 100 });
    const c2 = small.connect();
    const id2 = c2.account.addSheet('Data');
    c2.account.sheets.get(id2)!.set('Sheet1', [[1, 2], [3, 4]]);
    expect(await small.hub.documents(c2.ctx()).readSheet(id2, {})).toEqual({ values: [[1, 2], [3, 4]], truncated: false });
    expect(await small.hub.documents(c2.ctx()).readSheet(id2, { range: 'A1:B1' })).toEqual({ values: [[1, 2]], truncated: false });
  });

  it('an append whose outcome is unknown is not retried and is reported as ambiguous', async () => {
    const w = world();
    const c = w.connect();
    const docs = w.hub.documents(c.ctx());
    const id = c.account.addSheet();
    w.fake.failNext('POST .*:append', { status: 503 });
    expect(await docs.appendRows(id, undefined, [['a']])).toEqual({ updatedRange: null, ambiguous: true });
    expect(w.fake.requestsTo('POST .*:append')).toHaveLength(1);
    w.fake.failNext('POST .*:append', 'timeout');
    expect(await docs.appendRows(id, undefined, [['b']])).toEqual({ updatedRange: null, ambiguous: true });
    w.fake.failNext('POST .*:append', 'network');
    expect((await docs.appendRows(id, undefined, [['c']])).ambiguous).toBe(true);
    expect(w.fake.requestsTo('POST .*:append')).toHaveLength(3);
    // a 429 was not applied, so it IS retried
    w.fake.failNext('POST .*:append', { status: 429, headers: { 'retry-after': '2' } });
    expect((await docs.appendRows(id, undefined, [['d']])).ambiguous).toBe(false);
    expect(w.sleeps).toEqual([2000]);
    expect(c.account.sheets.get(id)!.get('Sheet1')).toEqual([['d']]);
  });

  it('uploads a file as multipart with the bytes intact, and creates folders and spreadsheets in a folder', async () => {
    const w = world();
    const c = w.connect();
    const docs = w.hub.documents(c.ctx());
    const folder = await docs.createFolder({ name: 'Proofs' });
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x10]);
    const f = await docs.uploadFile({ name: 'proof é.pdf', contentType: 'application/pdf', bytes, folderId: folder.id });
    expect(f).toMatchObject({ kind: 'pdf', name: 'proof é.pdf', size: 8, parentId: folder.id });
    expect(c.account.uploads.get(f.id)!.equals(bytes)).toBe(true);
    const up = w.fake.requestsTo('POST www.googleapis.com/upload/drive/v3/files')[0]!;
    expect(up.query.uploadType).toEqual(['multipart']);
    expect(up.headers['content-type']).toMatch(/^multipart\/related; boundary=/);
    const s = await docs.createSpreadsheet({ title: 'Log', folderId: folder.id });
    expect(s).toMatchObject({ kind: 'spreadsheet', parentId: folder.id });
    expect(w.fake.requestsTo('PUT')).toHaveLength(0); // no headers, no values call
  });
});

describe('typed errors, backoff and abort', () => {
  it('maps each Google answer to its typed error', async () => {
    const w = world();
    const c = w.connect();
    const mail = w.hub.mail(c.ctx());
    const cases: [number, unknown, CapabilityErrorCode][] = [
      [404, { error: { status: 'NOT_FOUND', errors: [{ reason: 'notFound' }] } }, 'NOT_FOUND'],
      [403, { error: { status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }, 'PERMISSION_MISSING'],
      [403, { error: { message: 'Request had insufficient authentication scopes.' } }, 'PERMISSION_MISSING'],
      [403, { error: { errors: [{ reason: 'dailyLimitExceeded' }] } }, 'QUOTA_EXCEEDED'],
      [403, { error: { errors: [{ reason: 'storageQuotaExceeded' }] } }, 'QUOTA_EXCEEDED'],
      [403, { error: { errors: [{ reason: 'appNotAuthorizedToFile' }] } }, 'PERMISSION_MISSING'],
      [403, { error: { errors: [{ reason: 'forbidden' }] } }, 'PERMISSION_MISSING'],
      [403, { error: { details: [{ reason: 'SERVICE_DISABLED' }] } }, 'PROVIDER_ERROR'],
      [413, {}, 'TOO_LARGE'],
      [400, { error: { message: 'subject: marker-private-text' } }, 'PROVIDER_ERROR'],
    ];
    for (const [status, body, expected] of cases) {
      w.fake.failNext('labels$', { status, body });
      const e = await fail(mail.listLabels());
      expect(e.code).toBe(expected);
      expect(JSON.stringify(e.toJSON())).not.toContain('marker-private-text');
    }
    w.fake.failNext('labels$', { status: 403, body: { error: { errors: [{ reason: 'forbidden' }] } } });
    expect((await fail(mail.listLabels())).details).toMatchObject({ reason: 'FORBIDDEN' });
    w.fake.failNext('labels$', { status: 403, body: { error: { details: [{ reason: 'SERVICE_DISABLED' }] } } });
    expect((await fail(mail.listLabels())).details).toMatchObject({ status: 403, reason: 'API_DISABLED' });
  });

  it('a missing scope at Google is PERMISSION_MISSING even when the console believed it was granted', async () => {
    const w = world();
    const c = w.connect({ scopes: [SCOPE.gmailRead] }); // Google never granted gmail.send
    const e = await fail(w.hub.mail(c.ctx()).send({ to: [{ address: 'person-b@example.test' }], subject: 's', text: 't' }));
    expect(e).toMatchObject({ code: 'PERMISSION_MISSING', details: { reason: 'SCOPE' } });
    expect(c.account.sent).toHaveLength(0);
  });

  it('refreshes once on a 401 and retries; a second 401 means reconnect', async () => {
    const w = world();
    const c = w.connect();
    w.fake.failNext('labels$', { status: 401, body: { error: { status: 'UNAUTHENTICATED' } } });
    expect(await w.hub.mail(c.ctx()).listLabels()).toHaveLength(5);
    expect(w.refreshes).toEqual([c.id]);
    expect(w.fake.requestsTo('labels$')).toHaveLength(2);
    expect(w.fake.requestsTo('labels$')[1]!.bearer).toBe(c.account.accessToken);
    w.fake.failNext('labels$', { status: 401 }, 2);
    const e = await fail(w.hub.mail(c.ctx()).listLabels());
    expect(e).toMatchObject({ code: 'CONNECTION_NEEDS_RECONNECT', details: { reason: 'UNAUTHORIZED' } });
  });

  it('retries 429 and 5xx with exponential backoff and jitter, honouring Retry-After, at most 3 tries', async () => {
    const w = world();
    const c = w.connect();
    const mail = w.hub.mail(c.ctx());
    w.fake.failNext('labels$', { status: 503 }, 2);
    expect(await mail.listLabels()).toHaveLength(5);
    expect(w.sleeps).toEqual([375, 750]); // 500 and 1000 ms, jittered by 0.75
    w.sleeps.length = 0;
    w.fake.failNext('labels$', { status: 500 }, 3);
    const e = await fail(mail.listLabels());
    expect(e).toMatchObject({ code: 'PROVIDER_ERROR', details: { status: 500 } });
    expect(e.retryable).toBe(true);
    expect(w.sleeps).toHaveLength(2); // three tries, two waits
    w.sleeps.length = 0;
    w.fake.failNext('labels$', { status: 429, headers: { 'retry-after': '3' } });
    await mail.listLabels();
    expect(w.sleeps).toEqual([3000]);
  });

  it('reports RATE_LIMITED with retryAfterMs when the wait is too long or the tries run out', async () => {
    const w = world();
    const c = w.connect();
    w.fake.failNext('labels$', { status: 429, headers: { 'retry-after': '120' } });
    const e = await fail(w.hub.mail(c.ctx()).listLabels());
    expect(e).toMatchObject({ code: 'RATE_LIMITED', details: { retryAfterMs: 120_000 } });
    expect(w.sleeps).toEqual([]); // not slept through
    w.fake.failNext('labels$', { status: 403, body: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } }, 3);
    const e2 = await fail(w.hub.mail(c.ctx()).listLabels());
    expect(e2.code).toBe('RATE_LIMITED');
    expect(e2.details.retryAfterMs).toBeGreaterThan(0);
  });

  it('does not retry a send after a 5xx or a lost connection, and says the outcome is unknown', async () => {
    const w = world();
    const c = w.connect();
    const mail = w.hub.mail(c.ctx());
    const msg = { to: [{ address: 'person-b@example.test' }], subject: 's', text: 't' };
    w.fake.failNext('messages/send', { status: 503 });
    const e = await fail(mail.send(msg));
    expect(e).toMatchObject({ code: 'PROVIDER_ERROR', details: { status: 503, outcomeUnknown: true } });
    expect(e.retryable).toBe(false);
    w.fake.failNext('messages/send', 'timeout');
    expect(await fail(mail.send(msg))).toMatchObject({ details: { status: 0, outcomeUnknown: true } });
    expect(w.fake.requestsTo('messages/send')).toHaveLength(2);
    w.fake.failNext('messages/send', { status: 429, headers: { 'retry-after': '1' } });
    await mail.send(msg); // a 429 was not applied: retried
    expect(c.account.sent).toHaveLength(1);
  });

  it('retries a read after a lost connection', async () => {
    const w = world();
    const c = w.connect();
    w.fake.failNext('labels$', 'network');
    expect(await w.hub.mail(c.ctx()).listLabels()).toHaveLength(5);
    expect(w.fake.requestsTo('labels$')).toHaveLength(2);
  });

  it('aborts: before a call no request is made; during a call the request and the backoff are cancelled', async () => {
    const w = world();
    const c = w.connect();
    const ac = new AbortController();
    ac.abort();
    expect(await code(w.hub.mail(c.ctx(ac.signal)).listLabels())).toBe('ABORTED');
    expect(w.fake.requests).toHaveLength(0);
    w.fake.latencyMs = 5_000;
    const ac2 = new AbortController();
    const pending = code(w.hub.mail(c.ctx(ac2.signal)).listLabels());
    setTimeout(() => ac2.abort(), 20);
    expect(await pending).toBe('ABORTED');
    // the abort during a backoff sleep (the real, abortable sleep)
    w.fake.latencyMs = 0;
    const w2 = world(undefined, { realSleep: true });
    const c2 = w2.connect();
    w2.fake.failNext('labels$', { status: 503 }, 2);
    const ac3 = new AbortController();
    const started = Date.now();
    const waiting = code(w2.hub.mail(c2.ctx(ac3.signal)).listLabels());
    setTimeout(() => ac3.abort(), 30);
    expect(await waiting).toBe('ABORTED');
    expect(Date.now() - started).toBeLessThan(300); // the 375 ms backoff was cut short
    expect(w2.fake.requestsTo('labels$')).toHaveLength(1);
  });

  it('limits one connection to 4 requests in flight at a time', async () => {
    const w = world(undefined, { concurrency: 4 });
    const c = w.connect();
    for (let i = 0; i < 12; i++) c.account.addMessage({ subject: `m${i}` });
    w.fake.latencyMs = 15;
    await w.hub.mail(c.ctx()).search({ pageSize: 12 });
    expect(w.fake.maxInFlight).toBe(4);
  });
});

describe('the gate and independence', () => {
  it('a call without the capability fails with CAPABILITY_OFF and makes no request', async () => {
    const w = world();
    const c = w.connect({ capabilities: ['mail_read'] });
    expect(await code(w.hub.mail(c.ctx()).send({ to: [{ address: 'person-b@example.test' }], subject: 's', text: 't' }))).toBe('CAPABILITY_OFF');
    expect(await code(w.hub.mail(c.ctx()).modify('x', { archive: true }))).toBe('CAPABILITY_OFF');
    expect(await code(w.hub.calendar(c.ctx()).listCalendars())).toBe('CAPABILITY_OFF');
    expect(await code(w.hub.documents(c.ctx()).createFolder({ name: 'x' }))).toBe('CAPABILITY_OFF');
    expect(w.fake.requests).toHaveLength(0);
  });

  it('a switch that Google did not grant fails with PERMISSION_MISSING before any request', async () => {
    const w = world();
    const c = w.connect({ capabilities: ['mail_read', 'calendar_read', 'calendar_write'], granted: ['mail_read', 'calendar_read'] });
    expect(await code(w.hub.calendar(c.ctx()).createEvent({ title: 'x', start: '2026-03-02T12:00:00Z', end: '2026-03-02T13:00:00Z' }))).toBe('PERMISSION_MISSING');
    expect(w.fake.requests).toHaveLength(0);
  });

  it('uses two connections of one user independently: each token reaches only its own account', async () => {
    const w = world();
    const a = w.connect({ email: 'person-a@example.test', label: 'Work' });
    const b = w.connect({ email: 'person-c@example.test', label: 'Home' });
    a.account.addMessage({ subject: 'only in Work' });
    b.account.addMessage({ subject: 'only in Home' });
    const [fromA, fromB] = await Promise.all([w.hub.mail(a.ctx()).search({}), w.hub.mail(b.ctx()).search({})]);
    expect(fromA.items.map((m) => m.subject)).toEqual(['only in Work']);
    expect(fromB.items.map((m) => m.subject)).toEqual(['only in Home']);
    await w.hub.mail(b.ctx()).send({ to: [{ address: 'person-b@example.test' }], subject: 'from Home', text: 'x' });
    expect(a.account.sent).toHaveLength(0);
    expect(b.account.sent[0]!.headers.from).toEqual(['person-c@example.test']);
    for (const r of w.fake.requests) expect([a.account.accessToken, b.account.accessToken]).toContain(r.bearer);
    // a request for A's message with B's connection never reaches A's mailbox
    const aMsg = a.account.messages[0]!;
    expect(await code(w.hub.mail(b.ctx()).get(aMsg.id, { body: 'text' }))).toBe('NOT_FOUND');
    // and the two accounts' calendars and files are separate too
    await w.hub.calendar(a.ctx()).createEvent({ title: 'A only', start: '2026-03-02T12:00:00Z', end: '2026-03-02T13:00:00Z' });
    expect((await w.hub.calendar(b.ctx()).listEvents({ from: '2026-03-01T00:00:00Z', to: '2026-03-31T00:00:00Z' })).items).toHaveLength(0);
    await w.hub.documents(a.ctx()).createFolder({ name: 'A folder' });
    expect((await w.hub.documents(b.ctx()).searchFiles({})).items).toHaveLength(0);
  });
});
