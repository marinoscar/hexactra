// THE INTERFACE CONTRACT SUITE (E39.3 and E39.4, #601 and #602): what any provider's mail, calendar and documents capabilities must do,
// run through the capability hub exactly as callers use them. It is provider-neutral: it only calls the interface and asks the
// world three things the interface cannot know (seed an inbox message, count what was sent, count the invitations emailed).
// The same suite runs UNCHANGED against the in-memory double, the Google adapter with its fake and the Microsoft adapter with its fake
// (test/capability-contract.spec.ts). A method a provider cannot do for an account kind is declared in the capability matrix
// (src/connections/capability-matrix.ts) and the suite checks that it fails with NOT_SUPPORTED, not with a provider error, and that
// it made no request; and that the matrix and the behaviour agree both ways.
import { CapabilityError, type ConnectionContext } from '../../src/connections/capabilities';
import type { CapabilityHub } from '../../src/connections/capability-hub';
import { CAPABILITY_MATRIX, type MatrixColumn, type MatrixMethod } from '../../src/connections/capability-matrix';

export interface ContractAccount {
  ctx(signal?: AbortSignal): ConnectionContext;
  /** Puts a message in this account's inbox, unread, from another person. */
  seedMessage(m: { subject: string; text: string }): void;
  /** Mail this account sent, and calendar invitations emailed on its behalf, since the world was made. */
  sentCount(): number;
  invitationsSent(): number;
}

export interface ContractWorld {
  hub: CapabilityHub;
  /** The matrix column of the accounts in this world. */
  column: MatrixColumn;
  a: ContractAccount;
  /** A second connection of the same user to another account of the same kind. */
  b: ContractAccount;
  /** Requests the provider received (or calls its double got) so far: a call that fails with NOT_SUPPORTED must not move it. */
  requestCount(): number;
}

const outcome = async <T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string; error: CapabilityError }> => {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    if (e instanceof CapabilityError) return { ok: false, code: e.code, error: e };
    throw e;
  }
};

/** A valid call of each method, for the methods a world may declare unsupported. */
const SAMPLES: Partial<Record<MatrixMethod, (w: ContractWorld) => Promise<unknown>>> = {
  'documents.readSheet': (w) => w.hub.documents(w.a.ctx()).readSheet('any-file', {}),
  'documents.appendRows': (w) => w.hub.documents(w.a.ctx()).appendRows('any-file', undefined, [['x']]),
};

const collect = async <T extends { id: string }>(first: (token?: string) => Promise<{ items: T[]; nextPageToken: string | null }>): Promise<{ all: T[]; pages: number }> => {
  const all: T[] = [];
  let token: string | undefined;
  let pages = 0;
  do {
    const page = await first(token);
    all.push(...page.items);
    token = page.nextPageToken ?? undefined;
    pages++;
  } while (token && pages < 20);
  return { all, pages };
};

export function describeCapabilityContract(name: string, make: () => ContractWorld | Promise<ContractWorld>): void {
  describe(`capability contract: ${name}`, () => {
    let w: ContractWorld;
    const isUnsupported = (m: MatrixMethod): boolean => CAPABILITY_MATRIX[m][w.column].support === 'unsupported';
    beforeEach(async () => {
      w = await make();
    });

    describe('mail', () => {
      it('searches, and pages: every message once, at most the page size at a time, a last page without a token', async () => {
        for (let i = 0; i < 5; i++) w.a.seedMessage({ subject: `contract subject ${i}`, text: 'contract body' });
        const mail = w.hub.mail(w.a.ctx());
        const { all, pages } = await collect((pageToken) => mail.search({ pageSize: 2, pageToken }));
        expect(new Set(all.map((m) => m.id)).size).toBe(5);
        expect(pages).toBe(3);
        for (const m of all) expect(m).toMatchObject({ unread: true, subject: expect.stringContaining('contract subject') });
        const one = await mail.search({ subject: 'contract subject 3' });
        expect(one.items).toHaveLength(1);
        expect(one.nextPageToken).toBeNull();
        expect((await mail.search({ subject: 'no such subject anywhere' })).items).toEqual([]);
      });

      it('reads a message as text, marks it read, and reports a missing one as NOT_FOUND', async () => {
        w.a.seedMessage({ subject: 'readable', text: 'the plain body' });
        const mail = w.hub.mail(w.a.ctx());
        const id = (await mail.search({ subject: 'readable' })).items[0]!.id;
        const got = await mail.get(id, { body: 'text' });
        expect(got).toMatchObject({ id, subject: 'readable', unread: true, html: null, truncated: false });
        expect(got.text).toContain('the plain body');
        expect((await mail.get(id, { body: 'none' })).text).toBeNull();
        await mail.modify(id, { read: true });
        expect((await mail.get(id, { body: 'none' })).unread).toBe(false);
        const missing = await outcome(mail.get('does-not-exist', { body: 'text' }));
        expect(missing.ok ? 'ok' : missing.code).toBe('NOT_FOUND');
      });

      it('lists labels with a kind, drafts and sends: a draft is sent once, a whole message once', async () => {
        const mail = w.hub.mail(w.a.ctx());
        const labels = await mail.listLabels();
        expect(labels.length).toBeGreaterThan(0);
        for (const l of labels) expect(['system', 'user']).toContain(l.kind);
        expect(labels.some((l) => l.kind === 'system')).toBe(true);
        const before = w.a.sentCount();
        const { draftId } = await mail.createDraft({ to: [{ address: 'person-b@example.test' }], subject: 'draft subject', text: 'draft body' });
        expect(draftId).toEqual(expect.any(String));
        expect(w.a.sentCount()).toBe(before);
        expect((await mail.send({ draftId })).messageId).toEqual(expect.any(String));
        expect(w.a.sentCount()).toBe(before + 1);
        expect((await mail.send({ to: [{ address: 'person-b@example.test' }], subject: 'whole', text: 'whole body' })).messageId).toEqual(expect.any(String));
        expect(w.a.sentCount()).toBe(before + 2);
      });
    });

    describe('calendar', () => {
      const window = { from: '2026-03-02T00:00:00Z', to: '2026-03-03T00:00:00Z' };
      const times = { start: '2026-03-02T09:30:00-05:00', end: '2026-03-02T10:30:00-05:00' };

      it('has one primary calendar, and creates, lists, changes and deletes an event with explicit times', async () => {
        const cal = w.hub.calendar(w.a.ctx());
        expect((await cal.listCalendars()).filter((c) => c.primary)).toHaveLength(1);
        const e = await cal.createEvent({ title: 'contract event', ...times });
        expect(e).toMatchObject({ title: 'contract event', allDay: false, status: 'confirmed', attendees: [] });
        expect(Date.parse(e.start)).toBe(Date.parse(times.start));
        expect(Date.parse(e.end)).toBe(Date.parse(times.end));
        expect((await cal.listEvents(window)).items.map((x) => x.id)).toContain(e.id);
        expect((await cal.updateEvent(e.id, { title: 'renamed' })).title).toBe('renamed');
        await cal.deleteEvent(e.id, { notifyAttendees: false });
        expect((await cal.listEvents(window)).items.filter((x) => x.status !== 'cancelled').map((x) => x.id)).not.toContain(e.id);
        expect(w.a.invitationsSent()).toBe(0);
      });

      it('never emails attendees unless asked: it is created without notifying, or refused with NOTIFY_REQUIRED', async () => {
        const cal = w.hub.calendar(w.a.ctx());
        const r = await outcome(cal.createEvent({ title: 'with people', ...times, attendees: [{ address: 'person-b@example.test' }] }));
        if (r.ok) expect(r.value.attendees.map((x) => x.address)).toContain('person-b@example.test');
        else expect(r.code).toBe('NOTIFY_REQUIRED');
        expect(w.a.invitationsSent()).toBe(0);
      });

      it('answers busy time as blocks with offsets', async () => {
        const blocks = await w.hub.calendar(w.a.ctx()).freeBusy(window);
        expect(Array.isArray(blocks)).toBe(true);
        for (const b of blocks) expect(Date.parse(b.end)).toBeGreaterThan(Date.parse(b.start));
      });
    });

    describe('documents', () => {
      it('makes folders and files, finds them, and pages through a folder', async () => {
        const docs = w.hub.documents(w.a.ctx());
        const folder = await docs.createFolder({ name: 'contract folder' });
        expect(folder).toMatchObject({ kind: 'folder', name: 'contract folder' });
        const f = await docs.uploadFile({ name: 'contract.txt', contentType: 'text/plain', bytes: Buffer.from('hello contract'), folderId: folder.id });
        expect(f).toMatchObject({ name: 'contract.txt', size: 14 });
        expect(await docs.getFile(f.id)).toMatchObject({ id: f.id, name: 'contract.txt' });
        expect((await docs.searchFiles({ folderId: folder.id })).items.map((x) => x.id)).toContain(f.id);
        const missing = await outcome(docs.getFile('does-not-exist'));
        expect(missing.ok ? 'ok' : missing.code).toBe('NOT_FOUND');
      });

      it('creates a document, reads its text back, and appends', async () => {
        const docs = w.hub.documents(w.a.ctx());
        const d = await docs.createDocument({ title: 'contract document', text: 'first paragraph' });
        expect(d.kind).toBe('document');
        expect((await docs.readDocument(d.id)).text).toContain('first paragraph');
        await docs.appendToDocument(d.id, 'second paragraph');
        const after = await docs.readDocument(d.id);
        expect(after.text).toContain('first paragraph');
        expect(after.text).toContain('second paragraph');
        expect(after.truncated).toBe(false);
      });

      it('appends rows to a spreadsheet as values, never formulas', async () => {
        const docs = w.hub.documents(w.a.ctx());
        const sheet = await docs.createSpreadsheet({ title: 'contract sheet', headers: ['name', 'value'] });
        expect(sheet.kind).toBe('spreadsheet');
        const dangerous = '=HYPERLINK("https://evil.example.test","click")';
        if (isUnsupported('documents.appendRows')) {
          const r = await outcome(docs.appendRows(sheet.id, undefined, [['x', 1]]));
          expect(r.ok ? 'ok' : r.code).toBe('NOT_SUPPORTED');
          return;
        }
        const r = await docs.appendRows(sheet.id, undefined, [['alpha', 1], ['beta', dangerous]]);
        expect(r.ambiguous).toBe(false);
        const read = await docs.readSheet(sheet.id, {});
        expect(read.truncated).toBe(false);
        expect(read.values.slice(-2)).toEqual([['alpha', 1], ['beta', dangerous]]);
        expect(read.values[0]).toEqual(['name', 'value']);
      });
    });

    describe('gates and independence', () => {
      it('two connections to two accounts never see each other: mail, events and files stay apart', async () => {
        w.a.seedMessage({ subject: 'only in a', text: 'a' });
        w.b.seedMessage({ subject: 'only in b', text: 'b' });
        const a = (await w.hub.mail(w.a.ctx()).search({})).items.map((m) => m.subject);
        const b = (await w.hub.mail(w.b.ctx()).search({})).items.map((m) => m.subject);
        expect(a).toEqual(['only in a']);
        expect(b).toEqual(['only in b']);
        await w.hub.documents(w.a.ctx()).createFolder({ name: 'a-only folder' });
        expect((await w.hub.documents(w.b.ctx()).searchFiles({ text: 'a-only' })).items).toEqual([]);
      });

      it('a cancelled call is ABORTED before anything is sent', async () => {
        const ac = new AbortController();
        ac.abort();
        const before = w.requestCount();
        const r = await outcome(w.hub.mail(w.a.ctx(ac.signal)).listLabels());
        expect(r.ok ? 'ok' : r.code).toBe('ABORTED');
        expect(w.requestCount()).toBe(before);
      });
    });

    describe('the capability matrix and the behaviour agree', () => {
      it('a method the matrix marks unsupported for this kind of account fails with NOT_SUPPORTED and makes no request', async () => {
        const declared = (Object.keys(CAPABILITY_MATRIX) as MatrixMethod[]).filter(isUnsupported);
        for (const m of declared) {
          const sample = SAMPLES[m];
          if (!sample) throw new Error(`add a sample call for ${m} to the contract suite`);
          const before = w.requestCount();
          const r = await outcome(sample(w));
          expect({ method: m, code: r.ok ? 'ok' : r.code }).toEqual({ method: m, code: 'NOT_SUPPORTED' });
          expect(w.requestCount()).toBe(before);
        }
      });

      it('every method the matrix does not mark unsupported works (the sample calls above ran them)', () => {
        const supported = (Object.keys(CAPABILITY_MATRIX) as MatrixMethod[]).filter((m) => !isUnsupported(m));
        expect(supported.length).toBeGreaterThan(15);
      });
    });
  });
}
