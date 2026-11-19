// The capability contract and its in-memory double (E39.3, #601): the gate (capability off, permission missing) before any call,
// validation, limits, typed errors, independence of two connections, and the tags of every method.
import {
  CAPABILITY_METHODS,
  CapabilityError,
  METHOD_TAGS,
  mailAddress,
  outgoingMail,
  newEvent,
  isHeaderSafe,
  toCapabilityError,
  type CapabilityConnection,
} from '../src/connections';
import { ConnectionError } from '../src/connections/connections.errors';
import { createTestCapabilities } from '../src/connections/testing';

const ALL = ['mail_read', 'mail_send', 'mail_modify', 'calendar_read', 'calendar_write', 'docs_read', 'docs_write'] as const;

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof CapabilityError ? e.code : `other:${(e as Error).name}`;
  }
};

describe('method tags', () => {
  it('tags every method with an effect and a capability, and writes with a write capability', () => {
    expect(METHOD_TAGS.length).toBe(Object.values(CAPABILITY_METHODS).reduce((n, m) => n + Object.keys(m).length, 0));
    for (const t of METHOD_TAGS) {
      expect(['read', 'write']).toContain(t.effect);
      expect(ALL).toContain(t.capability);
      if (t.effect === 'read') expect(t.capability.endsWith('_read')).toBe(true);
      else expect(t.capability.endsWith('_read')).toBe(false);
    }
    const tag = (s: string, m: string) => METHOD_TAGS.find((t) => t.service === s && t.method === m)!;
    expect(tag('mail', 'send')).toMatchObject({ effect: 'write', capability: 'mail_send' });
    expect(tag('mail', 'createDraft')).toMatchObject({ effect: 'write', capability: 'mail_modify' });
    expect(tag('mail', 'modify')).toMatchObject({ effect: 'write', capability: 'mail_modify' });
    expect(tag('documents', 'appendRows')).toMatchObject({ effect: 'write', capability: 'docs_write' });
    expect(tag('calendar', 'freeBusy')).toMatchObject({ effect: 'read', capability: 'calendar_read' });
  });
});

describe('the gate', () => {
  it('a capability that is off fails with CAPABILITY_OFF and the provider is never called', async () => {
    const t = createTestCapabilities();
    const c = t.connections.add({ capabilities: ['mail_read'] });
    expect(await code(t.hub.mail(t.ctx(c)).send({ to: [{ address: 'person-b@example.test' }], subject: 's', text: 't' }))).toBe('CAPABILITY_OFF');
    expect(await code(t.hub.calendar(t.ctx(c)).listCalendars())).toBe('CAPABILITY_OFF');
    expect(await code(t.hub.documents(t.ctx(c)).createFolder({ name: 'x' }))).toBe('CAPABILITY_OFF');
    expect(t.fake.calls).toHaveLength(0);
    expect(await code(t.hub.mail(t.ctx(c)).listLabels())).toBe('ok');
    expect(t.fake.calls).toHaveLength(1);
  });

  it('a switch that is on but not granted fails with PERMISSION_MISSING, before any call', async () => {
    const t = createTestCapabilities();
    const c = t.connections.add({ capabilities: ['calendar_read', 'calendar_write'], granted: ['calendar_read'] });
    const e = await t.hub.calendar(t.ctx(c)).createEvent({ title: 'x', start: '2026-03-02T09:00:00Z', end: '2026-03-02T10:00:00Z' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CapabilityError);
    expect((e as CapabilityError).code).toBe('PERMISSION_MISSING');
    expect((e as CapabilityError).details.capability).toBe('calendar_write');
    expect(t.fake.calls).toHaveLength(0);
  });

  it('sending a saved draft also needs mail_modify; sending a whole message does not', async () => {
    const t = createTestCapabilities();
    const c = t.connections.add({ capabilities: ['mail_send'] });
    expect(await code(t.hub.mail(t.ctx(c)).send({ draftId: 'd1' }))).toBe('CAPABILITY_OFF');
    expect(await code(t.hub.mail(t.ctx(c)).send({ to: [{ address: 'person-b@example.test' }], subject: 's', text: 't' }))).toBe('ok');
    expect(await code(t.hub.mail(t.ctx(c)).createDraft({ to: [{ address: 'person-b@example.test' }], subject: 's', text: 't' }))).toBe('CAPABILITY_OFF');
  });

  it('paused, reconnect-needing, missing and foreign connections fail with their own codes', async () => {
    const t = createTestCapabilities();
    const paused = t.connections.add({ capabilities: ['mail_read'], status: 'paused', label: 'A' });
    const stale = t.connections.add({ capabilities: ['mail_read'], status: 'needs_reconnect', label: 'B' });
    const ok = t.connections.add({ capabilities: ['mail_read'], label: 'C' });
    expect(await code(t.hub.mail(t.ctx(paused)).listLabels())).toBe('CONNECTION_PAUSED');
    expect(await code(t.hub.mail(t.ctx(stale)).listLabels())).toBe('CONNECTION_NEEDS_RECONNECT');
    expect(await code(t.hub.mail({ connectionId: 'nope', userId: 'user-a' }).listLabels())).toBe('CONNECTION_NOT_FOUND');
    expect(await code(t.hub.mail({ connectionId: ok.id, userId: 'user-b' }).listLabels())).toBe('CONNECTION_NOT_FOUND');
    expect(t.fake.calls).toHaveLength(0);
  });

  it('is NOT_SUPPORTED when the provider has no adapter for that service', async () => {
    const t = createTestCapabilities();
    t.fake.without.add('calendar');
    const c = t.connections.add({ capabilities: ['calendar_read'] });
    expect(await code(t.hub.calendar(t.ctx(c)).listCalendars())).toBe('NOT_SUPPORTED');
    const g = t.connections.add({ capabilities: ['mail_read'], provider: 'microsoft', label: 'M' });
    expect(await code(t.hub.mail(t.ctx(g)).listLabels())).toBe('NOT_SUPPORTED');
  });
});

describe('validation and limits', () => {
  it('rejects invalid input with the paths and never the values', async () => {
    const t = createTestCapabilities();
    const c = t.connections.add({ capabilities: ['mail_read'] });
    const e = await t.hub.mail(t.ctx(c)).search({ from: 'secret-marker\nBcc: x@example.test', pageSize: 500 }).catch((x: unknown) => x as CapabilityError);
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.details.issues).toEqual(expect.arrayContaining(['0.from', '0.pageSize']));
    expect(JSON.stringify(e.toJSON())).not.toContain('secret-marker');
    expect(t.fake.calls).toHaveLength(0);
  });

  it('refuses a newline in a subject, a name or an address', () => {
    const base = { to: [{ address: 'person-b@example.test' }], text: 't' };
    expect(outgoingMail.safeParse({ ...base, subject: 'ok' }).success).toBe(true);
    expect(outgoingMail.safeParse({ ...base, subject: 'a\r\nBcc: x@example.test' }).success).toBe(false);
    expect(outgoingMail.safeParse({ ...base, subject: 'a\nb' }).success).toBe(false);
    expect(outgoingMail.safeParse({ to: [{ address: 'person-b@example.test', name: 'P\r\nX: y' }], subject: 's', text: 't' }).success).toBe(false);
    expect(mailAddress.safeParse({ address: 'person-b@example.test\r\nBcc: x@example.test' }).success).toBe(false);
    expect(mailAddress.safeParse({ address: 'a@example.test, b@example.test' }).success).toBe(false);
    expect(newEvent.safeParse({ title: 'x\ny', start: '2026-03-02', end: '2026-03-03' }).success).toBe(false);
    expect(isHeaderSafe('tab\tok')).toBe(true);
    expect(isHeaderSafe('a b')).toBe(false);
    expect(outgoingMail.safeParse({ to: [{ address: 'person-b@example.test' }], subject: 's' }).success).toBe(false);
  });

  it('cuts message text at the body limit and marks it truncated', async () => {
    const t = createTestCapabilities({ limits: { bodyChars: 100 } });
    const c = t.connections.add({ capabilities: ['mail_read'] });
    const m = t.fake.account(c.id).addMessage({ text: 'x'.repeat(500) });
    const got = await t.hub.mail(t.ctx(c)).get(m.id, { body: 'text' });
    expect(got.text).toHaveLength(100);
    expect(got.truncated).toBe(true);
    const short = t.fake.account(c.id).addMessage({ text: 'short' });
    expect((await t.hub.mail(t.ctx(c)).get(short.id, { body: 'text' })).truncated).toBe(false);
    expect((await t.hub.mail(t.ctx(c)).get(short.id, { body: 'none' })).text).toBeNull();
  });

  it('caps sheet reads at the cell limit and attachments at the byte limit', async () => {
    const t = createTestCapabilities({ limits: { sheetCells: 10, attachmentBytes: 5 } });
    const c = t.connections.add({ capabilities: ['docs_read', 'docs_write', 'mail_read'] });
    const sheet = await t.hub.documents(t.ctx(c)).createSpreadsheet({ title: 'S', headers: ['a', 'b'] });
    await t.hub.documents(t.ctx(c)).appendRows(sheet.id, undefined, [[1, 2], [3, 4], [5, 6]]);
    const read = await t.hub.documents(t.ctx(c)).readSheet(sheet.id, {});
    expect(read.truncated).toBe(false);
    t.fake.account(c.id).sheets.get(sheet.id)!.get('Sheet1')!.push(...Array.from({ length: 10 }, () => [1, 2, 3]));
    const big = await t.hub.documents(t.ctx(c)).readSheet(sheet.id, {});
    expect(big.truncated).toBe(true);
    expect(big.values.flat()).toHaveLength(10);
    expect(await code(t.hub.documents(t.ctx(c)).appendRows(sheet.id, undefined, Array.from({ length: 6 }, () => [1, 2])))).toBe('TOO_LARGE');
    const m = t.fake.account(c.id).addMessage({ attachments: [{ id: 'a1', bytes: Buffer.alloc(6) }] });
    expect(await code(t.hub.mail(t.ctx(c)).getAttachment(m.id, 'a1'))).toBe('TOO_LARGE');
    expect(await code(t.hub.documents(t.ctx(c)).uploadFile({ name: 'f', contentType: 'text/plain', bytes: Buffer.alloc(6) }))).toBe('TOO_LARGE');
  });

  it('pages at 50 at most', async () => {
    const t = createTestCapabilities();
    const c = t.connections.add({ capabilities: ['mail_read'] });
    for (let i = 0; i < 120; i++) t.fake.account(c.id).addMessage({ subject: `m${i}` });
    const p1 = await t.hub.mail(t.ctx(c)).search({ pageSize: 50 });
    expect(p1.items).toHaveLength(50);
    const p2 = await t.hub.mail(t.ctx(c)).search({ pageSize: 50, pageToken: p1.nextPageToken! });
    expect(p2.items).toHaveLength(50);
    const p3 = await t.hub.mail(t.ctx(c)).search({ pageSize: 50, pageToken: p2.nextPageToken! });
    expect(p3.items).toHaveLength(20);
    expect(p3.nextPageToken).toBeNull();
    expect(await code(t.hub.mail(t.ctx(c)).search({ pageSize: 51 }))).toBe('INVALID_INPUT');
  });
});

describe('the double', () => {
  it('two connections of one user never see each other', async () => {
    const t = createTestCapabilities();
    const a = t.connections.add({ capabilities: ['mail_read', 'mail_send'], label: 'Work', accountEmail: 'person-a@example.test' });
    const b = t.connections.add({ capabilities: ['mail_read', 'mail_send'], label: 'Home', accountEmail: 'person-c@example.test' });
    t.fake.account(a.id).addMessage({ subject: 'only in work' });
    expect((await t.hub.mail(t.ctx(a)).search({})).items).toHaveLength(1);
    expect((await t.hub.mail(t.ctx(b)).search({})).items).toHaveLength(0);
    await t.hub.mail(t.ctx(b)).send({ to: [{ address: 'person-b@example.test' }], subject: 'hi', text: 'x' });
    expect(t.fake.account(a.id).sent).toHaveLength(0);
    expect(t.fake.account(b.id).sent).toHaveLength(1);
  });

  it('writes sheet values raw, defaults calendar notifications to none and honours idempotency keys', async () => {
    const t = createTestCapabilities();
    const c = t.connections.add({ capabilities: ['docs_write', 'calendar_write'] });
    const sheet = await t.hub.documents(t.ctx(c)).createSpreadsheet({ title: 'S' });
    const r = await t.hub.documents(t.ctx(c)).appendRows(sheet.id, undefined, [['=HYPERLINK("https://example.test","x")', 1]]);
    expect(r.ambiguous).toBe(false);
    expect(t.fake.account(c.id).sheets.get(sheet.id)!.get('Sheet1')![0]![0]).toBe('=HYPERLINK("https://example.test","x")');
    const ev = { title: 'Lunch', start: '2026-03-02T12:00:00+00:00', end: '2026-03-02T13:00:00+00:00', idempotencyKey: 'key-0000001', attendees: [{ address: 'person-b@example.test' }] };
    const e1 = await t.hub.calendar(t.ctx(c)).createEvent(ev);
    const e2 = await t.hub.calendar(t.ctx(c)).createEvent(ev);
    expect(e2.id).toBe(e1.id);
    expect(t.fake.account(c.id).events).toHaveLength(1);
    expect(t.fake.account(c.id).writes.filter((w) => w.method === 'calendar.createEvent').every((w) => w.notifyAttendees === false)).toBe(true);
    await t.hub.calendar(t.ctx(c)).deleteEvent(e1.id, { notifyAttendees: true });
    expect(t.fake.account(c.id).writes.at(-1)).toMatchObject({ method: 'calendar.deleteEvent', notifyAttendees: true });
  });

  it('fails on demand, aborts and records the use', async () => {
    const t = createTestCapabilities();
    const c = t.connections.add({ capabilities: ['mail_read'] });
    t.fake.failNext('mail.listLabels', new CapabilityError('RATE_LIMITED', { retryAfterMs: 1500 }));
    const e = await t.hub.mail(t.ctx(c)).listLabels().catch((x: unknown) => x as CapabilityError);
    expect(e.code).toBe('RATE_LIMITED');
    expect(e.retryAfterMs).toBe(1500);
    expect(e.retryable).toBe(true);
    expect(t.connections.used).toHaveLength(0);
    await t.hub.mail(t.ctx(c)).listLabels();
    expect(t.connections.used).toEqual([c.id]);

    const ac = new AbortController();
    ac.abort();
    expect(await code(t.hub.mail(t.ctx(c, ac.signal)).listLabels())).toBe('ABORTED');
    const slow = createTestCapabilities();
    slow.fake.latencyMs = 5_000;
    const sc = slow.connections.add({ capabilities: ['mail_read'] });
    const ac2 = new AbortController();
    const pending = code(slow.hub.mail(slow.ctx(sc, ac2.signal)).listLabels());
    setTimeout(() => ac2.abort(), 20);
    expect(await pending).toBe('ABORTED');
  });
});

describe('error translation', () => {
  it('turns the token service errors into capability errors and never copies a message', () => {
    const reconnect = toCapabilityError(new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'SECRET-MESSAGE', { label: 'Work', reason: 'GRANT_REVOKED' }), {});
    expect(reconnect).toMatchObject({ code: 'CONNECTION_NEEDS_RECONNECT', details: { label: 'Work', reason: 'GRANT_REVOKED' } });
    expect(toCapabilityError(new ConnectionError('CONNECTION_PAUSED', 'x', { label: 'Work' }), {}).code).toBe('CONNECTION_PAUSED');
    expect(toCapabilityError(new ConnectionError('CONNECTION_UNAVAILABLE', 'x', { reason: 'refresh_wait_timeout' }), {})).toMatchObject({ code: 'PROVIDER_ERROR', details: { status: 503 } });
    const unknown = toCapabilityError(new Error('subject: private'), {});
    expect(unknown.code).toBe('PROVIDER_ERROR');
    expect(JSON.stringify(unknown.toJSON())).not.toContain('private');
    expect(toCapabilityError(Object.assign(new Error('x'), { name: 'AbortError' }), {}).code).toBe('ABORTED');
  });

  it('is typed by connection type: a CapabilityConnection has provider, label and the two capability lists', () => {
    const c: CapabilityConnection = { id: 'x', userId: 'u', provider: 'google', label: 'L', accountEmail: 'a@example.test', capabilities: [], granted: [], status: 'active', statusReason: null };
    expect(c.provider).toBe('google');
  });
});
