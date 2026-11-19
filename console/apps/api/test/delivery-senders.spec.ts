// The four senders (E39.6, #603) against the in-memory capability provider, a fake email transport and a fake webhook transport: what
// goes out, to whom, from what, and what a hostile run cannot change. No database, no network, no provider.
import { MASKED_OUTPUT } from '@app/shared/task-fields';

import { CapabilityError } from '../src/connections/capabilities';
import { sampleFacts } from '../src/deliveries/delivery-sample';
import { DeliveryFailure, failureFrom } from '../src/deliveries/delivery-sender';
import { runWebhookSchema } from '../src/platform/webhooks/hexactra.webhook-events';
import { EmailSender } from '../src/deliveries/senders/email.sender';
import { FolderSender } from '../src/deliveries/senders/folder.sender';
import { SheetRowSender } from '../src/deliveries/senders/sheet-row.sender';
import { DELIVERY_WEBHOOK_RESOLVER, DELIVERY_WEBHOOK_TRANSPORT, WebhookSender } from '../src/deliveries/senders/webhook.sender';
import { CONFIG_SCHEMAS } from '../src/deliveries/delivery.schemas';
import { DELIVERY, FakeLimits, FakeRecipients, RUN, SENSITIVE, USER, harness, links, setupEmailTemplates, type Harness } from './support/deliveries-harness';

beforeAll(setupEmailTemplates);

const OWN = 'person-a@example.test';
const OTHER = 'person-b@example.test';
const prismaFake = { user: { findUnique: async () => ({ displayName: 'Person A', email: OWN }) } };

function emailSender(h: Harness, over: { recipients?: FakeRecipients; limits?: FakeLimits; settings?: unknown; transport?: unknown } = {}) {
  const recipients = over.recipients ?? new FakeRecipients();
  const limits = over.limits ?? new FakeLimits();
  const sender = new EmailSender(prismaFake as never, recipients as never, links, limits as never, over.settings as never, over.transport as never, h.hub);
  return { sender, recipients, limits };
}
const emailCfg = (over: Record<string, unknown> = {}) => CONFIG_SCHEMAS.email.parse({ to: [OWN], ...over });
const viaConn = (h: Harness, over: Record<string, unknown> = {}) => emailCfg({ via: { connectionId: h.mailConn.id }, ...over });

describe('email through a connection', () => {
  it('sends one message per address, from the account, with the outputs table and the masked PDF', async () => {
    const h = harness();
    const { sender } = emailSender(h);
    const out = await sender.send(h.ctx({ kind: 'email', config: viaConn(h, { to: [OWN, 'person-c@example.test'] }) }));
    expect(out.status).toBe('sent');
    const sent = h.fake.account(h.mailConn.id).sent;
    expect(sent).toHaveLength(2);
    expect(sent.map((m) => m.to.map((a) => a.address))).toEqual([[OWN], ['person-c@example.test']]);
    const m = sent[0]!;
    expect(m.subject).toBe('Pay the car loan: succeeded on 2026-11-18');
    expect(m.html).toContain('Confirmation number');
    expect(m.html).toContain('C-8841');
    expect(m.html).toContain('USD 412.50');
    expect(m.text).toContain('Confirmation number: C-8841');
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments![0]).toMatchObject({ filename: 'hexactra-run-11111111-20261118.pdf', contentType: 'application/pdf' });
    expect(m.attachments![0]!.bytes.toString()).toContain('MASKED-REPORT');
    expect(out.detail).toMatchObject({ via: 'connection', recipients: 2, messages: 2 });
    // The log never holds an address, a subject or a body.
    expect(JSON.stringify(out.detail)).not.toMatch(/person-|Pay the car loan|C-8841/);
  });

  it('a sensitive output reads [hidden] unless the delivery carries it, in the HTML and the plain text', async () => {
    const h = harness();
    const { sender } = emailSender(h);
    await sender.send(h.ctx({ kind: 'email', config: viaConn(h) }));
    const plain = h.fake.account(h.mailConn.id).sent[0]!;
    for (const part of [plain.html!, plain.text!]) {
      expect(part).not.toContain(SENSITIVE);
      expect(part).toContain(MASKED_OUTPUT);
    }
    await sender.send(h.ctx({ kind: 'email', config: viaConn(h, { includeSensitive: true }) }));
    const carried = h.fake.account(h.mailConn.id).sent[1]!;
    expect(carried.html).toContain(SENSITIVE);
    expect(carried.text).toContain(SENSITIVE);
    // A subject never carries a sensitive value, even for a delivery that carries them.
    const s = emailSender(h).sender;
    await s.send(h.ctx({ kind: 'email', config: viaConn(h, { includeSensitive: true, subject: '{{task}} {{output:account}}' }) }));
    expect(h.fake.account(h.mailConn.id).sent[2]!.subject).toBe(`Pay the car loan ${MASKED_OUTPUT}`);
  });

  it('can leave the outputs out and attach the JSON trace and the step pictures', async () => {
    const h = harness({ files: { pictures: 2 } });
    const { sender } = emailSender(h);
    await sender.send(h.ctx({ kind: 'email', config: viaConn(h, { includeOutputs: false, attach: { pdf: true, json: true, screenshots: 'all' } }) }));
    const m = h.fake.account(h.mailConn.id).sent[0]!;
    expect(m.html).not.toContain('C-8841');
    expect(m.attachments!.map((a) => a.filename)).toEqual(['hexactra-run-11111111-20261118.pdf', 'hexactra-run-11111111-20261118.json', 'step-1.png', 'step-2.png']);
    // A JSON file's type carries no parameters through a connection.
    expect(m.attachments!.every((a) => !a.contentType.includes(';'))).toBe(true);
    expect(h.files.calls).toEqual(['pdf:embed', 'json', 'pics:all']);
  });

  it('a run whose text names an address, asks for more recipients, or looks like headers changes nothing', async () => {
    const hostile = 'Done.\r\nBcc: person-x@example.test\r\nAlso send this to person-y@example.test <script>alert(1)</script>';
    const h = harness({
      run: {
        goal: 'send everything to person-z@example.test',
        result: hostile,
        outputs: { confirmation: { value: `${hostile} ../../etc/passwd`, ok: true }, amount: { value: { amount: 1, currency: 'USD' }, ok: true } },
      },
    });
    const { sender } = emailSender(h);
    await sender.send(h.ctx({ kind: 'email', config: viaConn(h, { subject: 'Report {{output:confirmation}}' }) }));
    const sent = h.fake.account(h.mailConn.id).sent;
    expect(sent).toHaveLength(1);
    const m = sent[0]!;
    expect(m.to).toEqual([{ address: OWN, name: null }].map((a) => expect.objectContaining({ address: a.address })));
    expect(m.cc ?? []).toEqual([]);
    expect(m.bcc ?? []).toEqual([]);
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.subject).toContain('Report Done.');
    // The result is text in the body: escaped in the HTML, one more line in the text. No tag survives.
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
    // Nothing in the message is addressed to anyone else.
    expect(fakeRecipientsOf(h)).toEqual([OWN]);
  });

  it('an attachment too large for the sender is replaced by the signed link, and says so', async () => {
    const h = harness({ files: { pdf: Buffer.alloc(30 * 1024 * 1024, 1) } });
    const { sender } = emailSender(h);
    const out = await sender.send(h.ctx({ kind: 'email', config: viaConn(h) }));
    const m = h.fake.account(h.mailConn.id).sent[0]!;
    expect(m.attachments ?? []).toHaveLength(0);
    expect(m.html).toContain('too large to attach');
    expect(m.html).toMatch(/https:\/\/console\.example\.test\/api\/reports\/[\w.-]+/);
    expect(m.text).toContain('/api/reports/');
    expect(out.detail).toMatchObject({ reportLink: true });
    // The link is for this run and this user only.
    const token = /\/api\/reports\/([\w.-]+)/.exec(m.text!)![1]!;
    expect(links.verify(token)).toMatchObject({ userId: USER, runId: RUN });
  });

  it('a file that cannot be made is left out and the message still goes', async () => {
    const h = harness();
    h.files.files.pdf = async () => {
      throw new Error('render failed');
    };
    const { sender } = emailSender(h);
    const out = await sender.send(h.ctx({ kind: 'email', config: viaConn(h) }));
    expect(out.status).toBe('sent');
    expect(h.fake.account(h.mailConn.id).sent[0]!.html).toContain('could not be created');
    expect(out.detail).toMatchObject({ attachmentFailed: true });
  });

  it('refuses an address the owner has not confirmed, skips one that stopped the emails, and sends nothing when all have', async () => {
    const h = harness();
    const r = new FakeRecipients();
    r.states_.set(OTHER, 'unconfirmed');
    await expect(emailSender(h, { recipients: r }).sender.send(h.ctx({ kind: 'email', config: viaConn(h, { to: [OWN, OTHER] }) }))).rejects.toMatchObject({ code: 'RECIPIENT_NOT_CONFIRMED' });
    expect(h.fake.account(h.mailConn.id).sent).toHaveLength(0);

    r.states_.set(OTHER, 'unsubscribed');
    const out = await emailSender(h, { recipients: r }).sender.send(h.ctx({ kind: 'email', config: viaConn(h, { to: [OWN, OTHER] }) }));
    expect(out.status).toBe('sent');
    expect(fakeRecipientsOf(h)).toEqual([OWN]);
    expect(out.detail).toMatchObject({ recipients: 1, skippedUnsubscribed: 1 });

    const none = await emailSender(h, { recipients: r }).sender.send(h.ctx({ kind: 'email', config: viaConn(h, { to: [OTHER] }) }));
    expect(none).toMatchObject({ status: 'skipped', code: 'RECIPIENT_UNSUBSCRIBED' });
  });

  it('a recipient who is not the owner gets the one-time notice first, with the unsubscribe link in it and in every report', async () => {
    const h = harness();
    const r = new FakeRecipients();
    r.states_.set(OTHER, 'confirmed');
    const { sender } = emailSender(h, { recipients: r });
    await sender.send(h.ctx({ kind: 'email', config: viaConn(h, { to: [OTHER] }) }));
    let sent = h.fake.account(h.mailConn.id).sent;
    expect(sent).toHaveLength(2);
    expect(sent[0]!.subject).toBe('You will receive run reports from Person A');
    expect(sent[0]!.text).toContain('You will receive run reports from Person A through');
    expect(sent[0]!.text).toContain(`/api/deliveries/unsubscribe/tok-${OTHER}`);
    expect(sent[1]!.subject).toContain('Pay the car loan');
    expect(sent[1]!.html).toContain('Stop these emails');
    // The second run: no notice again, the footer link stays.
    await sender.send(h.ctx({ kind: 'email', config: viaConn(h, { to: [OTHER] }) }));
    sent = h.fake.account(h.mailConn.id).sent;
    expect(sent).toHaveLength(3);
    expect(sent[2]!.subject).toContain('Pay the car loan');
    expect(r.marked).toEqual([OTHER]);
    // The owner's own address never gets a notice or an unsubscribe link.
    const own = harness();
    await emailSender(own).sender.send(own.ctx({ kind: 'email', config: viaConn(own) }));
    expect(own.fake.account(own.mailConn.id).sent[0]!.html).not.toContain('Stop these emails');
  });

  it('stops at the daily limit before anything goes out', async () => {
    const h = harness();
    const limits = new FakeLimits();
    limits.used = 99;
    await expect(emailSender(h, { limits }).sender.send(h.ctx({ kind: 'email', config: viaConn(h, { to: [OWN, 'person-c@example.test'] }) }))).rejects.toMatchObject({ code: 'DAILY_LIMIT' });
    expect(h.fake.account(h.mailConn.id).sent).toHaveLength(0);
  });

  it('a retry sends only to the addresses that have not received it (the progress is recorded per address)', async () => {
    const h = harness();
    h.fake.failNext('mail.send', new CapabilityError('RATE_LIMITED', { retryAfterMs: 1000 }), 1);
    const cfg = viaConn(h, { to: [OWN, 'person-c@example.test'] });
    const { sender } = emailSender(h);
    // The first address goes, the second is refused.
    h.fake.failNext('mail.send', new CapabilityError('RATE_LIMITED'), 0);
    const first = h.ctx({ kind: 'email', config: cfg });
    await expect(
      (async () => {
        await sender.send({ ...first, record: async (p) => void h.recorded.push(p) });
      })(),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(h.fake.account(h.mailConn.id).sent).toHaveLength(0);
    // The retry carries what the first attempt recorded: here nothing went out, so both receive it.
    const retry = h.ctx({ kind: 'email', config: cfg, attempt: 2, prior: Object.assign({}, ...h.recorded) });
    await sender.send(retry);
    expect(h.fake.account(h.mailConn.id).sent).toHaveLength(2);
    // And a retry that knows the first address is done sends only the second.
    const h2 = harness();
    await emailSender(h2).sender.send(h2.ctx({ kind: 'email', config: viaConn(h2, { to: [OWN, 'person-c@example.test'] }), attempt: 2, prior: { done: [0], messages: 1 } }));
    expect(fakeRecipientsOf(h2)).toEqual(['person-c@example.test']);
  });

  it('turns a capability failure into its code, an unknown outcome into OUTCOME_UNKNOWN (never repeated)', async () => {
    const h = harness();
    h.fake.failNext('mail.send', new CapabilityError('PROVIDER_ERROR', { status: 0, outcomeUnknown: true }));
    await expect(emailSender(h).sender.send(h.ctx({ kind: 'email', config: viaConn(h) }))).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(failureFrom(new CapabilityError('RATE_LIMITED', { retryAfterMs: 5000 }))).toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterMs: 5000 });
    expect(failureFrom(new CapabilityError('CONNECTION_NEEDS_RECONNECT'))).toMatchObject({ code: 'CONNECTION_NEEDS_RECONNECT', retryable: false });
    expect(failureFrom(new Error('boom with person-a@example.test inside'))).toMatchObject({ code: 'INTERNAL' });
    expect(failureFrom(new Error('boom')).message).not.toContain('boom');
  });

  it('a connection that needs reconnecting fails with that code and sends nothing', async () => {
    const t = harness();
    const conn = t.mailConn as unknown as { status?: string };
    conn.status = 'needs_reconnect';
    await expect(emailSender(t).sender.send(t.ctx({ kind: 'email', config: viaConn(t) }))).rejects.toMatchObject({ code: 'CONNECTION_NEEDS_RECONNECT' });
  });

  it('a test is marked, carries sample values and no attachment, and reads no run', async () => {
    const h = harness();
    const { sender } = emailSender(h);
    const facts = sampleFacts(USER, { id: 't', name: 'Pay the car loan', outputs: [{ key: 'confirmation', label: 'Confirmation number', type: 'text', required: true }] });
    await sender.send(h.ctx({ kind: 'email', config: viaConn(h), test: true, material: null, facts }));
    const m = h.fake.account(h.mailConn.id).sent[0]!;
    expect(m.subject.startsWith('[TEST] ')).toBe(true);
    expect(m.html).toContain('This is a test');
    expect(m.html).toContain('Sample text');
    expect(m.attachments ?? []).toHaveLength(0);
    expect(h.files.calls).toEqual([]);
  });
});

function fakeRecipientsOf(h: Harness): string[] {
  return h.fake.account(h.mailConn.id).sent.flatMap((m) => m.to.map((a) => a.address));
}

describe('email through the console', () => {
  const settings = { get: async () => ({ provider: 'smtp', enabled: true, fromAddress: 'reports@example.test', fromName: 'Hexactra' }) };

  function transport(result: { success: boolean; rateLimited?: boolean; error?: string } = { success: true }) {
    const messages: { to: string; from: string; subject: string; html: string; text: string; headers?: Record<string, string>; attachments?: { filename: string; contentType: string; contentBase64: string; disposition: string }[] }[] = [];
    return { messages, send: async (_s: unknown, m: (typeof messages)[number]) => (messages.push(m), result) };
  }

  it('sends each address its own message from the configured sender, with the PDF as a base64 attachment', async () => {
    const h = harness();
    const t = transport();
    const { sender } = emailSender(h, { settings, transport: t });
    await sender.send(h.ctx({ kind: 'email', config: emailCfg({ to: [OWN, 'person-c@example.test'] }) }));
    expect(t.messages.map((m) => m.to)).toEqual([OWN, 'person-c@example.test']);
    const m = t.messages[0]!;
    expect(m.from).toBe('"Hexactra" <reports@example.test>');
    expect(m.attachments).toHaveLength(1);
    expect(Buffer.from(m.attachments![0]!.contentBase64, 'base64').toString()).toContain('MASKED-REPORT');
    expect(m.headers).toMatchObject({ 'Auto-Submitted': 'auto-generated' });
    expect(Object.keys(m.headers!).join()).not.toMatch(/bcc|cc/i);
  });

  it('puts the unsubscribe link in the headers for a recipient who is not the owner', async () => {
    const h = harness();
    const r = new FakeRecipients();
    r.states_.set(OTHER, 'confirmed');
    const t = transport();
    await emailSender(h, { recipients: r, settings, transport: t }).sender.send(h.ctx({ kind: 'email', config: emailCfg({ to: [OTHER] }) }));
    expect(t.messages[0]!.subject).toContain('You will receive');
    expect(t.messages[1]!.headers!['List-Unsubscribe']).toBe(`<https://console.example.test/api/deliveries/unsubscribe/tok-${OTHER}>`);
  });

  it('says why it could not: not set up, throttled, or refused, with no provider text kept', async () => {
    const h = harness();
    const run = (s: unknown, t: unknown) => emailSender(h, { settings: s, transport: t }).sender.send(h.ctx({ kind: 'email', config: emailCfg() }));
    await expect(run({ get: async () => ({ provider: null, enabled: true, fromAddress: 'a@example.test' }) }, transport())).rejects.toMatchObject({ code: 'EMAIL_NOT_CONFIGURED' });
    await expect(run({ get: async () => ({ provider: 'smtp', enabled: false, fromAddress: 'a@example.test' }) }, transport())).rejects.toMatchObject({ code: 'EMAIL_NOT_CONFIGURED' });
    await expect(run(settings, transport({ success: false, rateLimited: true }))).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    await expect(run(settings, transport({ success: false, error: 'connect ECONNREFUSED' }))).rejects.toMatchObject({ code: 'NETWORK_ERROR', retryable: true });
    const refused = await run(settings, transport({ success: false, error: 'Rejected person-a@example.test as spam' })).catch((e: DeliveryFailure) => e);
    expect(refused).toMatchObject({ code: 'EMAIL_REFUSED', retryable: false });
    expect(JSON.stringify([(refused as DeliveryFailure).message, (refused as DeliveryFailure).detail])).not.toContain('person-a');
  });

  it('is unavailable when the email slice is not there', async () => {
    const h = harness();
    await expect(emailSender(h, {}).sender.send(h.ctx({ kind: 'email', config: emailCfg() }))).rejects.toMatchObject({ code: 'KIND_UNAVAILABLE' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------

describe('spreadsheet row', () => {
  const sheetCfg = (h: Harness, fileId: string, over: Record<string, unknown> = {}) =>
    CONFIG_SCHEMAS.sheet_row.parse({
      connectionId: h.docsConn.id,
      fileId,
      columns: [
        { header: 'Date', value: { kind: 'field', field: 'run_date' } },
        { header: 'Confirmation', value: { kind: 'output', key: 'confirmation' } },
        { header: 'Amount', value: { kind: 'output', key: 'amount' } },
      ],
      ...over,
    });
  function withSheet(h: Harness, rows: unknown[][] = []) {
    const a = h.fake.account(h.docsConn.id);
    const f = a.addFile({ id: 'sheet-1', name: 'Loan payments', kind: 'spreadsheet', mimeType: 'application/vnd.google-apps.spreadsheet', parentId: null });
    a.sheets.set(f.id, new Map([['Sheet1', rows as never]]));
    return { a, id: f.id };
  }
  const sender = (h: Harness) => new SheetRowSender(links, h.hub);

  it('appends the mapped row with the headers first on an empty sheet, and the run id last', async () => {
    const h = harness();
    const { a, id } = withSheet(h);
    const out = await sender(h).send(h.ctx({ kind: 'sheet_row', config: sheetCfg(h, id) }));
    expect(out).toMatchObject({ status: 'sent', detail: { rows: 1, headersWritten: true } });
    expect(a.sheets.get(id)!.get('Sheet1')).toEqual([
      ['Date', 'Confirmation', 'Amount', 'Run ID'],
      ['2026-11-18', 'C-8841', 'USD 412.50', RUN],
    ]);
    // The second run adds only its row.
    await sender(h).send(h.ctx({ kind: 'sheet_row', config: sheetCfg(h, id) }));
    expect(a.sheets.get(id)!.get('Sheet1')!.length).toBe(3);
    expect(JSON.stringify(out.detail)).not.toMatch(/Loan|C-8841|Sheet1/);
  });

  it('writes a hostile value as text, in its own cell', async () => {
    const hostile = '=HYPERLINK("https://evil.example.test","x")';
    const h = harness({ run: { outputs: { confirmation: { value: hostile, ok: true }, amount: { value: { amount: 1, currency: null }, ok: true } } } });
    const { a, id } = withSheet(h, [['Date', 'Confirmation', 'Amount', 'Run ID']]);
    await sender(h).send(h.ctx({ kind: 'sheet_row', config: sheetCfg(h, id) }));
    const row = a.sheets.get(id)!.get('Sheet1')![1]!;
    expect(row[1]).toBe(hostile);
    expect(typeof row[1]).toBe('string');
    expect(row).toHaveLength(4);
  });

  it('is idempotent: the same run twice adds one row (a retry checks for its own row first)', async () => {
    const h = harness();
    const { a, id } = withSheet(h, [['Date', 'Confirmation', 'Amount', 'Run ID']]);
    const cfg = sheetCfg(h, id);
    await sender(h).send(h.ctx({ kind: 'sheet_row', config: cfg }));
    const again = await sender(h).send(h.ctx({ kind: 'sheet_row', config: cfg, attempt: 2 }));
    expect(again.detail).toMatchObject({ deduplicated: true });
    expect(a.sheets.get(id)!.get('Sheet1')).toHaveLength(2);
    expect(a.writes.filter((w) => w.method === 'documents.appendRows')).toHaveLength(1);
  });

  it('an ambiguous append is verified before anything is repeated: the row is there, so no second one', async () => {
    const h = harness();
    const { a, id } = withSheet(h, [['Date', 'Confirmation', 'Amount', 'Run ID']]);
    const orig = a.sheets.get(id)!.get('Sheet1')!;
    // The provider took the rows, then the answer was lost.
    h.fake.failNext('documents.appendRows', new CapabilityError('PROVIDER_ERROR', { status: 0, outcomeUnknown: true }));
    const real = h.fake.documents.bind(h.fake);
    h.fake.documents = ((ctx: never) => {
      const docs = real(ctx)!;
      const append = docs.appendRows;
      docs.appendRows = async (...args) => {
        try {
          return await append(...args);
        } catch (e) {
          orig.push([...(args[2][args[2].length - 1] as never[])]);
          throw e;
        }
      };
      return docs;
    }) as never;
    const out = await sender(h).send(h.ctx({ kind: 'sheet_row', config: sheetCfg(h, id) }));
    expect(out.detail).toMatchObject({ verifiedAfterAmbiguous: true });
    expect(orig.filter((r) => r.includes(RUN))).toHaveLength(1);
  });

  it('an ambiguous append whose row is not there fails retryably, and the retry appends once', async () => {
    const h = harness();
    const { a, id } = withSheet(h, [['Date', 'Confirmation', 'Amount', 'Run ID']]);
    h.fake.failNext('documents.appendRows', new CapabilityError('PROVIDER_ERROR', { status: 0, outcomeUnknown: true }));
    const cfg = sheetCfg(h, id);
    const first = await sender(h).send(h.ctx({ kind: 'sheet_row', config: cfg })).catch((e: DeliveryFailure) => e);
    expect(first).toMatchObject({ code: 'PROVIDER_ERROR', retryable: true, detail: { ambiguous: true } });
    expect(h.recorded).toContainEqual({ appendAmbiguous: true });
    const retry = await sender(h).send(h.ctx({ kind: 'sheet_row', config: cfg, attempt: 2, prior: { appendAmbiguous: true } }));
    expect(retry.status).toBe('sent');
    expect(a.sheets.get(id)!.get('Sheet1')!.filter((r) => r.includes(RUN))).toHaveLength(1);
  });

  it('createIfMissing makes the spreadsheet once (with its headers) and pins it', async () => {
    const h = harness();
    const pinned: string[] = [];
    const cfg = CONFIG_SCHEMAS.sheet_row.parse({ connectionId: h.docsConn.id, createIfMissing: true, columns: [{ header: 'Status', value: { kind: 'field', field: 'status' } }] });
    const out = await sender(h).send(h.ctx({ kind: 'sheet_row', config: cfg, pin: async ({ fileId }) => void pinned.push(fileId) }));
    expect(out.status).toBe('sent');
    expect(pinned).toHaveLength(1);
    const rows = h.fake.account(h.docsConn.id).sheets.get(pinned[0]!)!.get('Sheet1')!;
    expect(rows).toEqual([['Status', 'Run ID'], ['succeeded', RUN]]);
    expect(h.fake.account(h.docsConn.id).files.find((f) => f.id === pinned[0])!.name).toBe('Pay the car loan');
  });

  it('a test row is marked in its Run ID cell, returns where it landed and never matches a real run', async () => {
    const h = harness();
    const { a, id } = withSheet(h, [['Date', 'Confirmation', 'Amount', 'Run ID']]);
    const out = await sender(h).send(h.ctx({ kind: 'sheet_row', config: sheetCfg(h, id), test: true, material: null }));
    expect(out.detail.location).toBe('Sheet1!A2:D2');
    const row = a.sheets.get(id)!.get('Sheet1')![1]!;
    expect(String(row[3])).toMatch(/^TEST-[0-9a-f]{8}$/);
    expect(row).not.toContain(RUN);
  });

  it('fails with the connection\'s code, without sending, when the account must be reconnected or the file is gone', async () => {
    const h = harness();
    const { id } = withSheet(h);
    (h.docsConn as { status?: string }).status = 'needs_reconnect';
    await expect(sender(h).send(h.ctx({ kind: 'sheet_row', config: sheetCfg(h, id) }))).rejects.toMatchObject({ code: 'CONNECTION_NEEDS_RECONNECT', retryable: false });
    const h2 = harness();
    await expect(sender(h2).send(h2.ctx({ kind: 'sheet_row', config: sheetCfg(h2, 'missing') }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------

describe('folder', () => {
  const folderCfg = (h: Harness, over: Record<string, unknown> = {}) => CONFIG_SCHEMAS.folder.parse({ target: { connectionId: h.docsConn.id, folderId: 'folder-1' }, files: { pdf: true, json: true, screenshots: 'all' }, nameTemplate: '{{task}} {{date}}', ...over });
  const sender = (h: Harness, store?: unknown) => new FolderSender(h.hub, store as never);

  it('uploads each file to the folder under the templated name', async () => {
    const h = harness({ files: { pictures: 1 } });
    const out = await sender(h).send(h.ctx({ kind: 'folder', config: folderCfg(h) }));
    expect(out).toMatchObject({ status: 'sent', detail: { destination: 'folder', files: 3 } });
    const a = h.fake.account(h.docsConn.id);
    const names = a.files.filter((f) => f.parentId === 'folder-1').map((f) => f.name);
    expect(names).toEqual(['Pay the car loan 2026-11-18.pdf', 'Pay the car loan 2026-11-18.json', 'Pay the car loan 2026-11-18 step-1.png']);
    const uploads = h.fake.callsOf('documents.uploadFile');
    expect(uploads.map((c) => (c.args[0] as { contentType: string }).contentType)).toEqual(['application/pdf', 'application/json', 'image/png']);
    const pdf = [...a.uploads.values()][0]!;
    expect(pdf.toString()).toContain('MASKED-REPORT');
  });

  it('a hostile value in the name template escapes no folder', async () => {
    const h = harness({ run: { outputs: { confirmation: { value: '../../../etc/passwd\r\nX', ok: true }, amount: { value: 1, ok: true } } } });
    await sender(h).send(h.ctx({ kind: 'folder', config: folderCfg(h, { nameTemplate: '{{output:confirmation}}', files: { pdf: true, json: false, screenshots: 'none' } }) }));
    const uploaded = h.fake.callsOf('documents.uploadFile').map((c) => c.args[0] as { name: string; folderId: string });
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]!.folderId).toBe('folder-1');
    expect(uploaded[0]!.name).not.toMatch(/[\\/\r\n]|\.\./);
    expect(uploaded[0]!.name).toBe('etc passwd X.pdf');
  });

  it('is idempotent: a retry skips a file that is already in the folder', async () => {
    const h = harness();
    const cfg = folderCfg(h, { files: { pdf: true, json: true, screenshots: 'none' } });
    await sender(h).send(h.ctx({ kind: 'folder', config: cfg }));
    await sender(h).send(h.ctx({ kind: 'folder', config: cfg, attempt: 2 }));
    expect(h.fake.callsOf('documents.uploadFile')).toHaveLength(2);
  });

  it('saves to the deployment storage under the owner\'s own prefix, with the same key on every attempt', async () => {
    const h = harness({ run: { outputs: { confirmation: { value: '../../other-user/x', ok: true }, amount: { value: 1, ok: true } } } });
    const puts: { key: string; type: string; bytes: number }[] = [];
    const store = { put: async (key: string, bytes: Buffer, type: string) => void puts.push({ key, type, bytes: bytes.length }) };
    const cfg = folderCfg(h, { target: 'storage', nameTemplate: '{{output:confirmation}}', files: { pdf: true, json: true, screenshots: 'none' } });
    await sender(h, store).send(h.ctx({ kind: 'folder', config: cfg }));
    await sender(h, store).send(h.ctx({ kind: 'folder', config: cfg, attempt: 2 }));
    expect(puts.map((p) => p.key)).toEqual([`deliveries/${USER}/${RUN}/other-user x.pdf`, `deliveries/${USER}/${RUN}/other-user x.json`, `deliveries/${USER}/${RUN}/other-user x.pdf`, `deliveries/${USER}/${RUN}/other-user x.json`]);
    for (const p of puts) expect(p.key).not.toContain('..');
    expect(await sender(h).send(h.ctx({ kind: 'folder', config: cfg })).catch((e: DeliveryFailure) => e)).toMatchObject({ code: 'KIND_UNAVAILABLE' });
  });

  it('a test saves one small text file, never a run\'s report', async () => {
    const h = harness();
    await sender(h).send(h.ctx({ kind: 'folder', config: folderCfg(h), test: true, material: null }));
    const up = h.fake.callsOf('documents.uploadFile').map((c) => c.args[0] as { name: string; contentType: string });
    expect(up).toHaveLength(1);
    expect(up[0]!.name).toMatch(/TEST\.txt$/);
    expect(up[0]!.contentType).toBe('text/plain');
    expect(h.files.calls).toEqual([]);
  });

  it('fails with the folder\'s code, and records what was already uploaded', async () => {
    const h = harness();
    h.fake.failNext('documents.uploadFile', new CapabilityError('NOT_FOUND'));
    await expect(sender(h).send(h.ctx({ kind: 'folder', config: folderCfg(h) }))).rejects.toMatchObject({ code: 'NOT_FOUND', retryable: false });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------

describe('webhook', () => {
  const cfg = (over: Record<string, unknown> = {}) => CONFIG_SCHEMAS.webhook.parse({ url: 'https://hooks.example.test/run', ...over });
  const secrets = { get: async () => 'whsec_dGVzdC1zZWNyZXQtZm9yLXVuaXQtdGVzdHM=' };
  const publicResolver = { resolveAll: async () => [{ address: '93.184.216.34', family: 4 }] };

  function build(response: { status: number; retryAfter?: string | null } | Error = { status: 200 }, resolver: unknown = publicResolver) {
    const sent: { headers: Record<string, string>; body: string; target: unknown }[] = [];
    const transport = { send: async (req: { headers: Record<string, string>; body: string; target: unknown }) => (sent.push(req), response instanceof Error ? Promise.reject(response) : { status: response.status, retryAfter: response.retryAfter ?? null, snippet: '' }) };
    const s = new WebhookSender(links, secrets as never, { allowInsecureHttp: false, allowPrivateTargets: false, allowedHosts: [], requestTimeoutMs: 1000 } as never, transport as never, resolver as never);
    return { s, sent };
  }

  it('posts the signed envelope with the run fields, the outputs masked and the links', async () => {
    const h = harness();
    const { s, sent } = build();
    const out = await s.send(h.ctx({ kind: 'webhook', config: cfg() }));
    expect(out).toMatchObject({ status: 'sent', detail: { destination: 'hooks.example.test', httpStatus: 200 } });
    const req = sent[0]!;
    const env = JSON.parse(req.body) as { id: string; type: string; data: Record<string, unknown> };
    expect(env.type).toBe('runs.run.finished');
    expect(env.id).toBe(`run:${RUN}:delivery:${DELIVERY}`);
    expect(runWebhookSchema.safeParse(env.data).success).toBe(true);
    expect(env.data).toMatchObject({ runId: RUN, status: 'succeeded', outputsComplete: true, runUrl: `https://console.example.test/runs/${RUN}` });
    expect(String(env.data.reportUrl)).toContain('/api/reports/');
    expect(req.body).not.toContain(SENSITIVE);
    expect(req.headers['webhook-id']).toBe(env.id);
    expect(req.headers['webhook-signature']).toMatch(/^v1,/);
    expect(req.headers['webhook-timestamp']).toMatch(/^\d+$/);
  });

  it('carries a sensitive output only when the delivery was set up to', async () => {
    const h = harness();
    const { s, sent } = build();
    await s.send(h.ctx({ kind: 'webhook', config: cfg({ includeSensitive: true }) }));
    expect(sent[0]!.body).toContain(SENSITIVE);
  });

  it('the same id on every attempt (a receiver can tell a retry from a new event)', async () => {
    const h = harness();
    const { s, sent } = build();
    await s.send(h.ctx({ kind: 'webhook', config: cfg() }));
    await s.send(h.ctx({ kind: 'webhook', config: cfg(), attempt: 2 }));
    expect(sent[0]!.headers['webhook-id']).toBe(sent[1]!.headers['webhook-id']);
  });

  it('classifies the answer: rate limit and server errors retry, a refusal does not', async () => {
    const h = harness();
    await expect(build({ status: 429, retryAfter: '30' }).s.send(h.ctx({ kind: 'webhook', config: cfg() }))).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterMs: 30_000 });
    await expect(build({ status: 503 }).s.send(h.ctx({ kind: 'webhook', config: cfg() }))).rejects.toMatchObject({ code: 'HTTP_5XX', retryable: true });
    await expect(build({ status: 403 }).s.send(h.ctx({ kind: 'webhook', config: cfg() }))).rejects.toMatchObject({ code: 'HTTP_4XX', retryable: false });
    await expect(build(Object.assign(new Error('x'), { code: 'timeout' })).s.send(h.ctx({ kind: 'webhook', config: cfg() }))).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('never calls a private network address or an http one', async () => {
    const h = harness();
    const priv = build({ status: 200 }, { resolveAll: async () => [{ address: '10.0.0.5', family: 4 }] });
    await expect(priv.s.send(h.ctx({ kind: 'webhook', config: cfg() }))).rejects.toMatchObject({ code: 'DESTINATION_BLOCKED', retryable: false });
    expect(priv.sent).toHaveLength(0);
    const plain = build();
    await expect(plain.s.send(h.ctx({ kind: 'webhook', config: { url: 'http://hooks.example.test/x', includeOutputs: true, includeReportLink: true, includeSensitive: false } }))).rejects.toMatchObject({ code: 'DESTINATION_BLOCKED' });
    expect(plain.sent).toHaveLength(0);
  });

  it('fails without a secret, and a test is its own event type with no report link', async () => {
    const h = harness();
    const none = new WebhookSender(links, { get: async () => null } as never, undefined, undefined, publicResolver as never);
    await expect(none.send(h.ctx({ kind: 'webhook', config: cfg() }))).rejects.toMatchObject({ code: 'SECRET_MISSING' });
    const { s, sent } = build();
    await s.send(h.ctx({ kind: 'webhook', config: cfg(), test: true, material: null }));
    const env = JSON.parse(sent[0]!.body) as { type: string; data: Record<string, unknown> };
    expect(env.type).toBe('deliveries.test');
    expect(env.data).toMatchObject({ test: true });
    expect(env.data).not.toHaveProperty('reportUrl');
  });

  it('exposes injection tokens for the tests of the module', () => {
    expect(typeof DELIVERY_WEBHOOK_TRANSPORT).toBe('symbol');
    expect(typeof DELIVERY_WEBHOOK_RESOLVER).toBe('symbol');
  });
});
