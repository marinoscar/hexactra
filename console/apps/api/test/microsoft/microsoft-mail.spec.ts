// Outlook mail through the fake Graph (E39.4, #602): request shape, mapping, paging, truncation, escaping, sends that must not
// happen twice, throttling and abort. Every call goes through the capability hub, as callers do.
import { CapabilityError } from '../../src/connections/capabilities';
import { FakeGraph } from '../../src/connections/microsoft/testing/fake-graph';
import { kqlPhrase, searchParam } from '../../src/connections/microsoft/microsoft.mail';
import { createHarness, type Harness } from './harness';

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof CapabilityError ? e.code : `other:${(e as Error).name}`;
  }
};
const fail = async (p: Promise<unknown>): Promise<CapabilityError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof CapabilityError) return e;
    throw e;
  }
  throw new Error('expected a failure');
};

function setup(caps?: Parameters<Harness['connect']>[1], kind: 'work' | 'personal' = 'work') {
  const h = createHarness();
  const a = h.addAccount({ email: 'person-a@example.test', kind });
  const c = h.connect(a, caps);
  const mail = (signal?: AbortSignal) => h.hub.mail(c.ctx(signal));
  const graphCalls = (f?: (r: { method: string; path: string }) => boolean) => h.fake.calls((r) => r.host === 'graph.microsoft.com' && (!f || f(r)));
  return { h, a, c, mail, graphCalls };
}

describe('listLabels', () => {
  it('returns the well-known folders as system labels, the user folders and the categories as user ones, with ids that say which', async () => {
    const { a, mail } = setup();
    a.folders.set('F-1', { id: 'F-1', name: 'Receipts', alias: null });
    a.masterCategories.push('Blue category', 'Follow up');
    const labels = await mail().listLabels();
    expect(labels).toEqual(expect.arrayContaining([
      { id: 'folder:inbox', name: 'Inbox', kind: 'system' },
      { id: 'folder:archive', name: 'Archive', kind: 'system' },
      { id: 'folder:sentitems', name: 'Sent Items', kind: 'system' },
      { id: 'folder:F-1', name: 'Receipts', kind: 'user' },
      { id: 'category:Follow up', name: 'Follow up', kind: 'user' },
    ]));
    expect(labels.filter((l) => l.kind === 'system').map((l) => l.id)).toEqual(['folder:inbox', 'folder:archive', 'folder:drafts', 'folder:sentitems', 'folder:deleteditems', 'folder:junkemail']);
    expect(labels.filter((l) => l.id === 'folder:F-inbox')).toHaveLength(0);
  });
});

describe('search', () => {
  it('builds a $filter from the structured query, leading with the date the ordering needs, and maps the summaries', async () => {
    const { a, mail, graphCalls } = setup();
    a.addMessage({ subject: 'Quarterly report', from: { address: 'person-b@example.test', name: 'Person B' }, receivedDateTime: '2026-03-02T09:30:00Z', isRead: false, categories: ['Follow up'], attachments: [{ id: 'x', name: 'r.pdf', contentType: 'application/pdf', bytes: Buffer.from('x') }] });
    a.addMessage({ subject: 'Old', receivedDateTime: '2025-01-01T00:00:00Z' });
    const page = await mail().search({ from: 'person-b@example.test', after: '2026-01-01T00:00:00Z', before: '2026-12-31T00:00:00+01:00', unread: true, hasAttachment: true, label: 'category:Follow up', pageSize: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ subject: 'Quarterly report', threadId: expect.any(String), from: { address: 'person-b@example.test', name: 'Person B' }, to: [{ address: 'person-a@example.test' }], unread: true, hasAttachments: true, date: '2026-03-02T09:30:00Z', labels: ['folder:inbox', 'category:Follow up'] });
    const req = graphCalls((r) => r.path === '/me/messages')[0] as unknown as { query: Record<string, string>; headers: Record<string, string> };
    expect(req.query.$filter).toBe("receivedDateTime ge 2026-01-01T00:00:00Z and receivedDateTime lt 2026-12-30T23:00:00Z and from/emailAddress/address eq 'person-b@example.test' and isRead eq false and hasAttachments eq true and categories/any(c:c eq 'Follow up')");
    expect(req.query.$orderby).toBe('receivedDateTime desc');
    expect(req.query.$top).toBe('10');
    expect(req.query.$search).toBeUndefined();
    expect(req.headers.prefer).toContain('ImmutableId');
  });

  it('doubles a quote inside an OData string so a value cannot end the literal', async () => {
    const { mail, graphCalls, a } = setup();
    a.addMessage({ subject: 'x', categories: ["O'Reilly"] });
    const page = await mail().search({ label: "category:O'Reilly" });
    expect(page.items).toHaveLength(1);
    expect((graphCalls((r) => r.path === '/me/messages')[0] as unknown as { query: Record<string, string> }).query.$filter).toContain("c eq 'O''Reilly'");
    // An address with a quote is not an address the filter form takes: it is searched as text.
    a.addMessage({ subject: 'y', from: { address: "o'brien@example.test" } });
    expect((await mail().search({ from: "o'brien@example.test" })).items.map((m) => m.subject)).toEqual(['y']);
    // A value shaped like more clauses stays one literal, matching nothing, and Graph accepts the request.
    expect((await mail().search({ from: "x@example.test' or isRead eq false or from/emailAddress/address eq 'y@example.test" })).items).toHaveLength(0);
  });

  it('uses $search for free text, a subject or a name, with the whole expression quoted and escaped', async () => {
    const { a, mail, graphCalls } = setup();
    a.addMessage({ subject: 'Lunch plans', text: 'see you at noon' });
    a.addMessage({ subject: 'Other', text: 'nothing' });
    const page = await mail().search({ text: 'noon', subject: 'Lunch', from: 'Person B' });
    expect(page.items.map((m) => m.subject)).toEqual(['Lunch plans']);
    const q = (graphCalls((r) => r.path === '/me/messages')[0] as unknown as { query: Record<string, string> }).query;
    expect(q.$search).toBe(searchParam('"noon" AND subject:"Lunch" AND from:"Person B"'));
    expect(q.$filter).toBeUndefined();
    expect(q.$orderby).toBeUndefined();
  });

  it('treats query operators inside a value as text: it neither matches other messages nor reaches Graph as an operator', async () => {
    const { a, mail } = setup();
    a.addMessage({ subject: 'secret plans', text: 'about secrets', from: { address: 'person-b@example.test' } });
    a.addMessage({ subject: 'harmless', text: 'plain' });
    const attack = 'plain" OR subject:"secret';
    expect((await mail().search({ text: attack })).items).toHaveLength(0);
    expect((await mail().search({ text: 'x\\" OR "y' })).items).toHaveLength(0);
    // The escaping itself.
    expect(kqlPhrase('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(searchParam('subject:"a\\"b"')).toBe('"subject:\\"a\\\\\\"b\\""');
    // A literal containing the operator text is found as text.
    a.addMessage({ subject: 'has "quotes" and AND inside' });
    expect((await mail().search({ subject: 'has "quotes" and AND inside' })).items).toHaveLength(1);
  });

  it('applies the filters $search cannot take to each page: dates, unread, attachment, category', async () => {
    const { a, mail } = setup();
    a.addMessage({ subject: 'budget one', receivedDateTime: '2026-03-02T00:00:00Z', isRead: false });
    a.addMessage({ subject: 'budget two', receivedDateTime: '2026-03-03T00:00:00Z', isRead: true });
    a.addMessage({ subject: 'budget three', receivedDateTime: '2025-03-03T00:00:00Z', isRead: false, categories: ['Follow up'] });
    expect((await mail().search({ text: 'budget', unread: true, after: '2026-01-01T00:00:00Z' })).items.map((m) => m.subject)).toEqual(['budget one']);
    expect((await mail().search({ text: 'budget', label: 'category:Follow up' })).items.map((m) => m.subject)).toEqual(['budget three']);
    expect((await mail().search({ text: 'budget', hasAttachment: true })).items).toHaveLength(0);
    expect((await mail().search({ text: 'budget', before: '2026-03-03T00:00:00Z' })).items.map((m) => m.subject).sort()).toEqual(['budget one', 'budget three']);
  });

  it('searches one folder through its own path, and refuses a label that is not a folder or category id', async () => {
    const { a, mail, graphCalls } = setup();
    a.addMessage({ subject: 'in inbox' });
    a.addMessage({ subject: 'archived', folderId: 'F-archive' });
    expect((await mail().search({ label: 'folder:archive' })).items.map((m) => m.subject)).toEqual(['archived']);
    expect(graphCalls((r) => r.path === '/me/mailFolders/archive/messages')).toHaveLength(1);
    expect(await code(mail().search({ label: 'INBOX' }))).toBe('INVALID_INPUT');
  });

  it('pages: a next link becomes an opaque token, the next page continues from it, and the last page has none', async () => {
    const { a, mail } = setup();
    for (let i = 0; i < 5; i++) a.addMessage({ subject: `m${i}`, receivedDateTime: `2026-03-0${i + 1}T00:00:00Z` });
    const p1 = await mail().search({ pageSize: 2 });
    expect(p1.items.map((m) => m.subject)).toEqual(['m4', 'm3']);
    expect(p1.nextPageToken).toEqual(expect.any(String));
    expect(p1.nextPageToken).not.toContain('graph.microsoft.com');
    const p2 = await mail().search({ pageSize: 2, pageToken: p1.nextPageToken! });
    expect(p2.items.map((m) => m.subject)).toEqual(['m2', 'm1']);
    const p3 = await mail().search({ pageSize: 2, pageToken: p2.nextPageToken! });
    expect(p3.items.map((m) => m.subject)).toEqual(['m0']);
    expect(p3.nextPageToken).toBeNull();
  });

  it('reads a next link that names the user by id as the same account, and never lets a token aim elsewhere', async () => {
    const { a, h, mail, graphCalls } = setup();
    h.fake.rewriteNextLinks = true;
    for (let i = 0; i < 3; i++) a.addMessage({ subject: `m${i}`, receivedDateTime: `2026-03-0${i + 1}T00:00:00Z` });
    const p1 = await mail().search({ pageSize: 2 });
    const p2 = await mail().search({ pageSize: 2, pageToken: p1.nextPageToken! });
    expect(p2.items).toHaveLength(1);
    expect(graphCalls().every((r) => !r.path.startsWith('/users'))).toBe(true);
    const aimed = Buffer.from('/me/drive/root/children?x=1').toString('base64url');
    expect(await code(mail().search({ pageToken: aimed }))).toBe('INVALID_INPUT');
    expect(await code(mail().search({ pageToken: Buffer.from('//evil.example.test/me/messages?').toString('base64url') }))).toBe('INVALID_INPUT');
    expect(await code(mail().search({ pageToken: 'not-a-token' }))).toBe('INVALID_INPUT');
  });

  it('never returns more than 50 per page, whatever the caller asks', async () => {
    const { mail, graphCalls } = setup();
    expect(await code(mail().search({ pageSize: 500 }))).toBe('INVALID_INPUT');
    await mail().search({ pageSize: 50 });
    expect((graphCalls((r) => r.path === '/me/messages').pop() as unknown as { query: Record<string, string> }).query.$top).toBe('50');
  });

  it('turns a short page into a next token, not an empty end', async () => {
    const { a, mail } = setup();
    for (let i = 0; i < 4; i++) a.addMessage({ subject: `budget ${i}`, receivedDateTime: `2026-03-0${i + 1}T00:00:00Z`, isRead: i === 3 });
    const p1 = await mail().search({ text: 'budget', unread: true, pageSize: 2 });
    expect(p1.items.map((m) => m.subject)).toEqual(['budget 2']);
    expect(p1.nextPageToken).not.toBeNull();
  });
});

describe('get', () => {
  const seed = (a: ReturnType<typeof setup>['a']) => a.addMessage({ subject: 'Hello', text: 'plain body', html: '<p>html <b>body</b></p>', cc: [{ address: 'person-c@example.test' }], attachments: [{ id: 'att1', name: 'doc.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF') }] });

  it('asks for the text body and maps the message, its recipients and its attachments', async () => {
    const { a, mail, graphCalls } = setup();
    const m = seed(a);
    const got = await mail().get(m.id, { body: 'text' });
    expect(got).toMatchObject({ id: m.id, subject: 'Hello', text: 'html body', html: null, truncated: false, cc: [{ address: 'person-c@example.test' }], internetMessageId: m.internetMessageId, hasAttachments: true, attachments: [{ id: 'att1', filename: 'doc.pdf', contentType: 'application/pdf', size: 4 }] });
    const req = graphCalls((r) => r.path === `/me/messages/${m.id}`)[0] as unknown as { headers: Record<string, string> };
    expect(req.headers.prefer).toContain('outlook.body-content-type="text"');
  });

  it('returns html only when asked, and no body at all for `none` (and does not ask for it)', async () => {
    const { a, mail, graphCalls } = setup();
    const m = seed(a);
    const html = await mail().get(m.id, { body: 'html' });
    expect(html).toMatchObject({ html: '<p>html <b>body</b></p>', text: null });
    const none = await mail().get(m.id, { body: 'none' });
    expect(none).toMatchObject({ html: null, text: null });
    const last = graphCalls((r) => r.path === `/me/messages/${m.id}`).pop() as unknown as { query: Record<string, string> };
    expect(last.query.$select.split(',')).not.toContain('body');
  });

  it('cuts a long body at the limit and marks it truncated', async () => {
    const { a, mail } = setup();
    const m = a.addMessage({ subject: 'Long', text: 'x'.repeat(60_000) });
    const got = await mail().get(m.id, { body: 'text' });
    expect(got.text).toHaveLength(50_000);
    expect(got.truncated).toBe(true);
  });

  it('reports a missing message as NOT_FOUND', async () => {
    const { mail } = setup();
    expect(await code(mail().get('nope', { body: 'text' }))).toBe('NOT_FOUND');
  });

  it('downloads a file attachment, refuses an attached message, and refuses a too-large one before fetching it', async () => {
    const { a, mail, graphCalls } = setup();
    const m = a.addMessage({
      subject: 'with files',
      attachments: [
        { id: 'f1', name: 'a.txt', contentType: 'text/plain', bytes: Buffer.from('hello') },
        { id: 'i1', name: 'fwd.eml', contentType: 'message/rfc822', bytes: Buffer.from('x'), kind: 'item' },
        { id: 'big', name: 'big.bin', contentType: 'application/octet-stream', bytes: Buffer.alloc(11 * 1024 * 1024) },
      ],
    });
    const ok = await mail().getAttachment(m.id, 'f1');
    expect(ok).toMatchObject({ filename: 'a.txt', contentType: 'text/plain', size: 5 });
    expect(ok.bytes.toString()).toBe('hello');
    expect(await code(mail().getAttachment(m.id, 'i1'))).toBe('NOT_SUPPORTED');
    expect(await code(mail().getAttachment(m.id, 'big'))).toBe('TOO_LARGE');
    expect(graphCalls((r) => r.path.endsWith('/big/$value'))).toHaveLength(0);
  });
});

describe('drafts and sends', () => {
  const to = [{ address: 'person-b@example.test', name: 'Person B' }];

  it('creates a draft as a Graph message, with the account as the sender and no way to send as another', async () => {
    const { a, mail, graphCalls } = setup();
    const { draftId } = await mail().createDraft({ to, cc: [{ address: 'person-c@example.test' }], subject: 'Héllo ✓', html: '<p>hi</p>', attachments: [{ filename: 'n.txt', contentType: 'text/plain', bytes: Buffer.from('abc') }] });
    const req = graphCalls((r) => r.method === 'POST' && r.path === '/me/messages')[0] as unknown as { json: Record<string, unknown> };
    expect(req.json).toMatchObject({ subject: 'Héllo ✓', body: { contentType: 'html', content: '<p>hi</p>' }, toRecipients: [{ emailAddress: { address: 'person-b@example.test', name: 'Person B' } }], ccRecipients: [{ emailAddress: { address: 'person-c@example.test' } }], attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'n.txt', contentBytes: Buffer.from('abc').toString('base64') }] });
    expect(req.json.from).toBeUndefined();
    expect(req.json.sender).toBeUndefined();
    expect(a.messages.find((m) => m.id === draftId)).toMatchObject({ isDraft: true, folderId: 'F-drafts' });
    expect(a.sent).toHaveLength(0);
  });

  it('sends a large attachment through an upload session, in chunks that Graph accepts', async () => {
    const { a, mail, graphCalls, h } = setup();
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 123, 7);
    const { draftId } = await mail().createDraft({ to, subject: 'big', text: 't', attachments: [{ filename: 'big.bin', contentType: 'application/octet-stream', bytes }] });
    expect(a.messages.find((m) => m.id === draftId)!.attachments[0]!.bytes.equals(bytes)).toBe(true);
    expect(graphCalls((r) => r.path.endsWith('/attachments/createUploadSession'))).toHaveLength(1);
    const chunks = h.fake.calls((r) => r.host === 'upload.fake.example.test');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.headers['content-range']).toMatch(/^bytes 0-3276799\/4194427$/);
    expect(chunks.every((c) => c.headers.authorization === undefined)).toBe(true);
  });

  it('replies through the reply endpoints so the thread is kept', async () => {
    const { a, mail } = setup();
    const orig = a.addMessage({ subject: 'Question', conversationId: 'CONV-X' });
    const { draftId } = await mail().createDraft({ to, subject: 'Re: Question', text: 'answer', inReplyTo: orig.id });
    expect(a.messages.find((m) => m.id === draftId)).toMatchObject({ conversationId: 'CONV-X', replyTo: orig.id, text: 'answer', isDraft: true });
  });

  it('sends a whole message through a draft when the modify switch is on, and the recipient gets it', async () => {
    const { h, a, mail } = setup();
    const b = h.addAccount({ email: 'person-b@example.test' });
    const r = await mail().send({ to, subject: 'Hi', text: 'hello' });
    expect(a.sent).toEqual([{ to: ['person-b@example.test'], subject: 'Hi', viaDraft: true }]);
    expect(b.messages.map((m) => m.subject)).toEqual(['Hi']);
    expect(r.messageId).toEqual(expect.any(String));
    expect(a.messages.find((m) => m.id === r.messageId)).toMatchObject({ isDraft: false, folderId: 'F-sentitems' });
  });

  it('sends a saved draft', async () => {
    const { a, mail } = setup();
    const { draftId } = await mail().createDraft({ to, subject: 'later', text: 't' });
    expect((await mail().send({ draftId })).messageId).toBe(draftId);
    expect(a.sent).toHaveLength(1);
  });

  it('with send-only permission uses /me/sendMail: no draft, no message id, attachments under 3 MB', async () => {
    const { a, mail, graphCalls } = setup(['mail_send']);
    const r = await mail().send({ to, subject: 'Hi', text: 'hello', attachments: [{ filename: 'n.txt', contentType: 'text/plain', bytes: Buffer.from('abc') }] });
    expect(r.messageId).toMatch(/^sendmail:/);
    expect(a.sent).toEqual([{ to: ['person-b@example.test'], subject: 'Hi', viaDraft: false }]);
    expect(graphCalls((r2) => r2.path === '/me/messages' && r2.method === 'POST')).toHaveLength(0);
    expect(await code(mail().send({ to, subject: 'big', text: 't', attachments: [{ filename: 'b.bin', contentType: 'application/octet-stream', bytes: Buffer.alloc(3 * 1024 * 1024 + 1) }] }))).toBe('TOO_LARGE');
    expect(a.sent).toHaveLength(1);
  });

  it('a reply with send-only permission uses the reply endpoint with the body in `message`', async () => {
    const { a, mail, graphCalls } = setup(['mail_send']);
    const orig = a.addMessage({ subject: 'Question' });
    await mail().send({ to, subject: 'Re: Question', text: 'answer', inReplyTo: orig.id });
    const req = graphCalls((r) => r.path === `/me/messages/${orig.id}/reply`)[0] as unknown as { json: Record<string, unknown> };
    expect(req.json.comment).toBeUndefined();
    expect(req.json.message).toMatchObject({ body: { content: 'answer' } });
    expect(a.sent).toHaveLength(1);
  });

  it('a send retried after throttling waits for Retry-After and sends once', async () => {
    const { h, a, mail } = setup();
    h.fake.throttle((r) => r.path.endsWith('/send'), 2, '3');
    await mail().send({ to, subject: 'Hi', text: 'hello' });
    expect(h.sleeps).toEqual([3000, 3000]);
    expect(a.sent).toHaveLength(1);
  });
});

describe('a send retried after an ambiguous failure does not send twice', () => {
  const to = [{ address: 'person-b@example.test' }];

  it('looks at the draft before sending again: the answer was lost but the mail went (a 504 after processing)', async () => {
    const { h, a, mail } = setup();
    h.fake.failAfter((r) => r.path.endsWith('/send'), 504);
    const r = await mail().send({ to, subject: 'Once', text: 't' });
    expect(a.sent).toHaveLength(1);
    expect(a.messages.find((m) => m.id === r.messageId)!.isDraft).toBe(false);
  });

  it('looks at the draft before sending again: a dropped connection after processing', async () => {
    const { h, a, mail } = setup();
    h.fake.failAfter((r) => r.path.endsWith('/send'), 0);
    await mail().send({ to, subject: 'Once', text: 't' });
    expect(a.sent).toHaveLength(1);
  });

  it('sends again only when the draft is still there: the request never arrived', async () => {
    const { h, a, mail } = setup();
    h.fake.fail((r) => r.path.endsWith('/send'), 503);
    await mail().send({ to, subject: 'Once', text: 't' });
    expect(a.sent).toHaveLength(1);
    const sends = h.fake.calls((r) => r.path.endsWith('/send'));
    expect(sends).toHaveLength(2);
  });

  it('a caller retry with the same idempotency key returns the first send, when the first answer was lost', async () => {
    const { h, a, mail } = setup();
    const key = 'send-key-0001';
    const first = await mail().send({ to, subject: 'Once', text: 't', idempotencyKey: key });
    const again = await mail().send({ to, subject: 'Once', text: 't', idempotencyKey: key });
    expect(again.messageId).toBe(first.messageId);
    expect(a.sent).toHaveLength(1);
    // Another key is another send.
    await mail().send({ to, subject: 'Once', text: 't', idempotencyKey: 'send-key-0002' });
    expect(a.sent).toHaveLength(2);
    expect(h.fake.calls((r) => r.method === 'POST' && r.path === '/me/messages')).toHaveLength(2);
  });

  it('keys are per connection: the same key on another account is another send', async () => {
    const { h, a, mail } = setup();
    const b = h.addAccount({ email: 'person-d@example.test' });
    const c2 = h.connect(b);
    const key = 'shared-key-001';
    await mail().send({ to, subject: 'Once', text: 't', idempotencyKey: key });
    await h.hub.mail(c2.ctx()).send({ to, subject: 'Once', text: 't', idempotencyKey: key });
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });

  it('after a send that cannot be verified, the retry with the same key finishes the draft instead of making a new one', async () => {
    const { h, a, mail } = setup();
    const key = 'send-key-0003';
    h.fake.failAfter((r) => r.path.endsWith('/send'), 504);
    h.fake.drop((r) => r.method === 'GET' && r.path.startsWith('/me/messages/') && r.query.$select === 'id,isDraft', 3);
    const first = await fail(mail().send({ to, subject: 'Once', text: 't', idempotencyKey: key }));
    expect(first.details.reason).toBe('AMBIGUOUS');
    expect(a.sent).toHaveLength(1);
    const again = await mail().send({ to, subject: 'Once', text: 't', idempotencyKey: key });
    expect(again.messageId).toEqual(expect.any(String));
    expect(a.sent).toHaveLength(1);
    expect(h.fake.calls((r) => r.method === 'POST' && r.path === '/me/messages')).toHaveLength(1);
  });

  it('with send-only permission a lost answer is never retried, and the same key is refused until the owner checks', async () => {
    const { h, a, mail } = setup(['mail_send']);
    const key = 'send-key-0004';
    h.fake.failAfter((r) => r.path === '/me/sendMail', 504);
    const first = await fail(mail().send({ to, subject: 'Once', text: 't', idempotencyKey: key }));
    expect(first.code).toBe('PROVIDER_ERROR');
    expect(first.details.reason).toBe('AMBIGUOUS');
    expect(a.sent).toHaveLength(1);
    const again = await fail(mail().send({ to, subject: 'Once', text: 't', idempotencyKey: key }));
    expect(again.code).toBe('CONFLICT');
    expect(again.details.reason).toBe('SEND_AMBIGUOUS');
    expect(a.sent).toHaveLength(1);
    expect(h.fake.calls((r) => r.path === '/me/sendMail')).toHaveLength(1);
  });

  it('a send that failed for good frees its key and leaves no draft behind', async () => {
    const { h, a, mail } = setup();
    const key = 'send-key-0005';
    h.fake.fail((r) => r.path.endsWith('/send'), 400, 'ErrorInvalidRecipients');
    expect(await code(mail().send({ to, subject: 'Bad', text: 't', idempotencyKey: key }))).toBe('PROVIDER_ERROR');
    expect(a.messages.filter((m) => m.isDraft)).toHaveLength(0);
    await mail().send({ to, subject: 'Bad', text: 't', idempotencyKey: key });
    expect(a.sent).toHaveLength(1);
  });

  it('two calls with one key at the same time: the second is refused as in flight', async () => {
    const { mail } = setup();
    const key = 'send-key-0006';
    const results = await Promise.allSettled([mail().send({ to, subject: 'Once', text: 't', idempotencyKey: key }), mail().send({ to, subject: 'Once', text: 't', idempotencyKey: key })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as CapabilityError).details.reason).toBe('IN_FLIGHT');
  });
});

describe('modify', () => {
  it('marks read, archives to the Archive folder, and brings it back to the inbox', async () => {
    const { a, mail } = setup();
    const m = a.addMessage({ subject: 'x', isRead: false });
    await mail().modify(m.id, { read: true, archive: true });
    expect(m).toMatchObject({ isRead: true, folderId: 'F-archive' });
    await mail().modify(m.id, { archive: false });
    expect(m.folderId).toBe('F-inbox');
    await mail().modify(m.id, { read: false });
    expect(m.isRead).toBe(false);
  });

  it('maps labels to categories: adds and removes by name, keeping the others', async () => {
    const { a, mail } = setup();
    const m = a.addMessage({ subject: 'x', categories: ['Keep', 'Drop'] });
    await mail().modify(m.id, { addLabels: ['category:New'], removeLabels: ['category:Drop'] });
    expect(m.categories).toEqual(['Keep', 'New']);
  });

  it('moves to a folder named as a label, and treats removing the inbox as archiving', async () => {
    const { a, mail } = setup();
    a.folders.set('F-1', { id: 'F-1', name: 'Receipts', alias: null });
    const m = a.addMessage({ subject: 'x' });
    await mail().modify(m.id, { addLabels: ['folder:F-1'] });
    expect(m.folderId).toBe('F-1');
    const n = a.addMessage({ subject: 'y' });
    await mail().modify(n.id, { removeLabels: ['folder:inbox'] });
    expect(n.folderId).toBe('F-archive');
  });

  it('refuses what a folder-and-category model cannot say, before changing anything', async () => {
    const { a, mail, graphCalls } = setup();
    const m = a.addMessage({ subject: 'x' });
    expect(await code(mail().modify(m.id, { addLabels: ['UNREAD'] }))).toBe('INVALID_INPUT');
    expect(await code(mail().modify(m.id, { addLabels: ['folder:archive', 'folder:drafts'] }))).toBe('INVALID_INPUT');
    expect(await code(mail().modify(m.id, { archive: true, addLabels: ['folder:drafts'] }))).toBe('INVALID_INPUT');
    expect(await code(mail().modify(m.id, { removeLabels: ['folder:drafts'] }))).toBe('INVALID_INPUT');
    expect(graphCalls((r) => r.method !== 'GET')).toHaveLength(0);
    expect(m.folderId).toBe('F-inbox');
  });
});

describe('errors, throttling and abort', () => {
  it('maps the answers to typed errors and never copies the provider message', async () => {
    const { h, mail } = setup();
    const cases: [number, string, string][] = [
      [404, 'ErrorItemNotFound', 'NOT_FOUND'],
      [403, 'ErrorAccessDenied', 'PERMISSION_MISSING'],
      [507, 'ErrorQuotaExceeded', 'QUOTA_EXCEEDED'],
      [413, 'ErrorMessageSizeExceeded', 'TOO_LARGE'],
      [409, 'ErrorIrresolvableConflict', 'CONFLICT'],
      [400, 'ErrorInvalidProperty', 'PROVIDER_ERROR'],
    ];
    for (const [status, c, expected] of cases) {
      h.fake.fail((r) => r.path === '/me/mailFolders', status, c);
      const e = await fail(mail().listLabels());
      expect(e.code).toBe(expected);
      expect(`${e.message} ${JSON.stringify(e)}`).not.toContain(FakeGraph.CONTENT_MARKER);
    }
  });

  it('a 403 names the capability that lacked its permission', async () => {
    const { h, mail } = setup();
    h.fake.fail((r) => r.path === '/me/mailFolders', 403, 'ErrorAccessDenied');
    const e = await fail(mail().listLabels());
    expect(e.details.capability).toBe('mail_read');
  });

  it('retries a throttled read after Retry-After, up to three tries, then gives RATE_LIMITED with the wait', async () => {
    const { h, mail } = setup();
    h.fake.throttle((r) => r.path === '/me/mailFolders', 1, '2');
    await mail().listLabels();
    expect(h.sleeps).toEqual([2000]);
    h.sleeps.length = 0;
    h.fake.throttle((r) => r.path === '/me/mailFolders', 5, '7');
    const e = await fail(mail().listLabels());
    expect(e.code).toBe('RATE_LIMITED');
    expect(e.retryAfterMs).toBe(7000);
    expect(e.retryable).toBe(true);
    expect(h.sleeps).toEqual([7000, 7000]);
  });

  it('does not wait out a Retry-After longer than the cap: it tells the caller', async () => {
    const { h, mail } = setup();
    h.fake.throttle((r) => r.path === '/me/mailFolders', 1, '3600');
    const e = await fail(mail().listLabels());
    expect(e).toMatchObject({ code: 'RATE_LIMITED', details: { retryAfterMs: 3_600_000 } });
    expect(h.sleeps).toEqual([]);
  });

  it('backs off on 5xx for a read, three tries in all, with growing waits', async () => {
    const { h, mail } = setup();
    h.fake.fail((r) => r.path === '/me/mailFolders', 503, 'ServiceUnavailable', 5);
    const e = await fail(mail().listLabels());
    expect(e).toMatchObject({ code: 'PROVIDER_ERROR', details: { status: 503 } });
    expect(h.sleeps).toHaveLength(2);
    expect(h.sleeps[1]!).toBeGreaterThan(h.sleeps[0]!);
    expect(h.fake.calls((r) => r.path === '/me/mailFolders')).toHaveLength(3);
  });

  it('never repeats a write blindly after a 5xx or a dropped connection: it says the outcome is unknown', async () => {
    const { h, mail } = setup();
    h.fake.fail((r) => r.method === 'POST' && r.path === '/me/messages', 503);
    const e = await fail(mail().createDraft({ to: [{ address: 'person-b@example.test' }], subject: 's', text: 't' }));
    expect(e.details).toMatchObject({ status: 503, reason: 'AMBIGUOUS' });
    expect(h.fake.calls((r) => r.method === 'POST' && r.path === '/me/messages')).toHaveLength(1);
  });

  it('a 401 forces one refresh of the token and one retry', async () => {
    const { h, mail } = setup();
    await mail().listLabels();
    h.fake.expireAllTokens();
    await mail().listLabels();
    const tokens = new Set(h.fake.calls((r) => r.host === 'graph.microsoft.com').map((r) => r.headers.authorization));
    expect(tokens.size).toBe(2);
    h.fake.answer((r) => r.path === '/me/mailFolders', () => new Response('{}', { status: 401 }), 5);
    expect((await fail(mail().listLabels())).code).toBe('CONNECTION_NEEDS_RECONNECT');
  });

  it('fails with ABORTED before any request when the signal is already aborted, and cancels a call under way', async () => {
    const { h, mail } = setup();
    const done = new AbortController();
    done.abort();
    expect(await code(mail(done.signal).listLabels())).toBe('ABORTED');
    expect(h.fake.requests).toHaveLength(0);
    const ac = new AbortController();
    h.fake.hang((r) => r.path === '/me/mailFolders');
    const pending = code(mail(ac.signal).listLabels());
    setTimeout(() => ac.abort(), 20);
    expect(await pending).toBe('ABORTED');
    // A call waiting for its turn (three at a time per connection) is cancelled too, without ever being sent.
    const ac2 = new AbortController();
    h.fake.hang((r) => r.path === '/me/mailFolders', 3);
    const stuck = [1, 2, 3].map(() => code(mail(ac2.signal).listLabels()));
    const queued = code(mail(ac2.signal).listLabels());
    setTimeout(() => ac2.abort(), 20);
    expect(await Promise.all([...stuck, queued])).toEqual(['ABORTED', 'ABORTED', 'ABORTED', 'ABORTED']);
  });

  it('runs at most three requests at a time per connection', async () => {
    const { h, mail } = setup();
    let active = 0;
    let peak = 0;
    const inner = h.fake.fetch;
    h.fake.fetch = (async (...args: Parameters<typeof fetch>) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await inner(...args);
      } finally {
        active--;
      }
    }) as typeof fetch;
    await Promise.all(Array.from({ length: 10 }, () => mail().listLabels()));
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
});

describe('one connection never sees another', () => {
  it('two connections of one person (work and personal) are read with their own tokens and their own mailboxes', async () => {
    const h = createHarness();
    const work = h.addAccount({ email: 'person-a@org-alpha.example.test', kind: 'work' });
    const personal = h.addAccount({ email: 'person-a@example.test', kind: 'personal' });
    work.addMessage({ subject: 'work only' });
    personal.addMessage({ subject: 'personal only' });
    const cw = h.connect(work);
    const cp = h.connect(personal);
    const [w, p] = await Promise.all([h.hub.mail(cw.ctx()).search({}), h.hub.mail(cp.ctx()).search({})]);
    expect(w.items.map((m) => m.subject)).toEqual(['work only']);
    expect(p.items.map((m) => m.subject)).toEqual(['personal only']);
    const byToken = new Map<string, Set<string>>();
    for (const r of h.fake.calls((x) => x.host === 'graph.microsoft.com')) byToken.set(r.headers.authorization!, (byToken.get(r.headers.authorization!) ?? new Set()).add(r.path));
    expect(byToken.size).toBe(2);
    // A message id of the other account is not found with this connection's token.
    expect(await code(h.hub.mail(cp.ctx()).get(work.messages[0]!.id, { body: 'text' }))).toBe('NOT_FOUND');
  });
});
