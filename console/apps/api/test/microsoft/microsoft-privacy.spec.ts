// No content in logs, spans, metrics or errors (E39.4, #602): a marker test. Every kind of content the provider handles (a subject, an
// address, a message body, a file name, a search query, a cell, an event title, a folder name) carries its own marker, through
// reads, writes, failures and throttling; then every log line, span (name, attributes, events, status), telemetry record and typed
// error is scanned. Graph's own error text carries a marker too: it must never be copied.
import { Logger } from '@nestjs/common';

import { CapabilityError } from '../../src/connections/capabilities';
import { defaultTelemetry } from '../../src/connections/microsoft/graph-client';
import { FakeGraph } from '../../src/connections/microsoft/testing/fake-graph';
import { createHarness } from './harness';
import { installMemoryTracing, spanText } from '../helpers/otel-memory';

const M = {
  subject: 'MARK-subject-8c1f',
  address: 'mark-address-8c1f@example.test',
  body: 'MARK-body-8c1f',
  file: 'MARK-file-8c1f',
  query: 'MARK-query-8c1f',
  cell: 'MARK-cell-8c1f',
  title: 'MARK-title-8c1f',
  folder: 'MARK-folder-8c1f',
  category: 'MARK-category-8c1f',
};
const CONTENT = [...Object.values(M), FakeGraph.CONTENT_MARKER];

describe('privacy in telemetry', () => {
  const tracing = installMemoryTracing();
  const logged: string[] = [];
  const spies: jest.SpyInstance[] = [];

  beforeAll(() => {
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) spies.push(jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' '))));
  });
  afterAll(async () => {
    spies.forEach((s) => s.mockRestore());
    await tracing.uninstall();
  });

  it('carries the operation, the connection id, the status, the sizes and the timing, and no content', async () => {
    // The default telemetry (spans and a warning per failure) is what runs in production: build the harness with it.
    const real = createHarness({ telemetry: defaultTelemetry });
    const a = real.addAccount({ email: 'person-a@example.test', kind: 'work' });
    const c = real.connect(a);
    const mail = real.hub.mail(c.ctx());
    const cal = real.hub.calendar(c.ctx());
    const docs = real.hub.documents(c.ctx());
    const errors: unknown[] = [];
    const attempt = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        errors.push(e);
      }
    };

    a.addMessage({ subject: M.subject, text: M.body, from: { address: M.address, name: M.title }, categories: [M.category] });
    a.addEvent({ subject: M.title, start: '2026-03-02T10:00:00Z', end: '2026-03-02T11:00:00Z', attendees: [{ address: M.address, response: 'none' }] });
    const wb = a.addWorkbook(`${M.file}.xlsx`, { Sheet1: { rows: [['h', 'i']], table: true } });

    // Reads, writes and searches carrying content.
    await mail.search({ text: M.query, from: M.address });
    await mail.search({ label: `category:${M.category}` });
    const found = await mail.search({});
    await mail.get(found.items[0]!.id, { body: 'text' });
    await mail.send({ to: [{ address: M.address, name: M.title }], subject: M.subject, text: M.body, attachments: [{ filename: `${M.file}.txt`, contentType: 'text/plain', bytes: Buffer.from(M.body) }] });
    await mail.createDraft({ to: [{ address: M.address }], subject: M.subject, text: M.body });
    await cal.listEvents({ from: '2026-03-01T00:00:00Z', to: '2026-03-09T00:00:00Z', text: M.query });
    await cal.createEvent({ title: M.title, location: M.folder, start: '2026-03-04T10:00:00Z', end: '2026-03-04T11:00:00Z', description: M.body });
    await attempt(cal.createEvent({ title: M.title, start: '2026-03-04T10:00:00Z', end: '2026-03-04T11:00:00Z', attendees: [{ address: M.address }] }));
    await docs.searchFiles({ text: M.query });
    await docs.createFolder({ name: M.folder });
    await docs.createDocument({ title: M.file, text: M.body });
    await docs.uploadFile({ name: `${M.file}.bin`, contentType: 'application/octet-stream', bytes: Buffer.from(M.body) });
    await docs.appendRows(wb.id, 'Sheet1', [[M.cell, M.subject]]);
    await docs.readSheet(wb.id, {});

    // Failures: Graph's own message carries content and must not travel.
    for (const status of [400, 403, 404, 409, 413, 429, 500, 503, 507]) {
      real.fake.fail((r) => r.host === 'graph.microsoft.com' && r.method === 'GET', status, 'ErrorInvalidProperty', 20);
      await attempt(mail.search({ text: M.query }));
      await attempt(docs.getFile(M.file));
      real.fake.clearScripts();
    }
    real.fake.throttle((r) => r.path === '/me/calendars', 2, '1');
    await attempt(cal.listCalendars());
    real.fake.failAfter((r) => r.path === '/me/sendMail', 504);
    await attempt(real.hub.mail(c.ctx()).send({ to: [{ address: M.address }], subject: M.subject, text: M.body, idempotencyKey: 'marker-key-1' }));

    const spans = tracing.spans();
    expect(spans.length).toBeGreaterThan(20);
    const ops = new Set(spans.map((s) => s.name));
    expect([...ops]).toEqual(expect.arrayContaining(['graph mail.search', 'graph mail.send_draft', 'graph calendar.create', 'graph files.upload', 'graph sheet.table_add']));
    const sample = spans.find((s) => s.name === 'graph mail.search')!;
    expect(sample.attributes).toMatchObject({ 'connection.id': c.id, 'graph.operation': 'mail.search', 'http.response.status_code': expect.any(Number), 'graph.duration_ms': expect.any(Number) });
    expect(Object.keys(sample.attributes).sort()).toEqual(['connection.id', 'graph.attempt', 'graph.duration_ms', 'graph.operation', 'graph.request_bytes', 'graph.response_bytes', 'http.response.status_code']);

    const everything = [...logged, ...spans.map(spanText), ...errors.map((e) => `${(e as Error).message} ${JSON.stringify(e)} ${(e as Error).stack ?? ''}`)].join('\n');
    for (const marker of CONTENT) expect({ marker, leaked: everything.includes(marker) }).toEqual({ marker, leaked: false });
    // The failures did get logged, as an operation and a status only.
    expect(logged.some((l) => /graph mail\.search answered 500/.test(l))).toBe(true);
    expect(errors.every((e) => e instanceof CapabilityError)).toBe(true);
    // No token in anything either.
    expect(everything).not.toMatch(/AT-[0-9a-f]{8}-\d+/);
  });
});
