// Privacy in telemetry (E39.3, #601): spans, metrics, logs and error values of the Google adapter carry the operation name, the
// connection id, sizes, counts, durations and status codes, and NEVER a subject, an address, a body, a file name, a search query or
// a cell. Markers are put in all of them, calls succeed and fail (Google's own error text carries a marker too), and every
// observable surface is scanned.
import { Logger } from '@nestjs/common';
import type { AppMetricsService } from '@marinoscar/platform-api/host';

import { CapabilityError, type CapabilityErrorCode } from '../src/connections/capabilities';
import { CapabilityHub } from '../src/connections/capability-hub';
import { CapabilityProviderRegistry } from '../src/connections/capability-provider.registry';
import { GoogleCapabilityProvider } from '../src/connections/google/google.provider';
import { GoogleHttp } from '../src/connections/google/google-http';
import { FakeGoogle } from '../src/connections/google/testing';
import { InMemoryConnections } from '../src/connections/testing';
import { installMemoryTracing, spanText } from './helpers/otel-memory';

const M = {
  subject: 'MARKER-subject-7f3a',
  address: 'marker-addr-7f3a@example.test',
  body: 'MARKER-body-7f3a',
  file: 'MARKER-file-7f3a.pdf',
  query: 'MARKER-query-7f3a',
  cell: 'MARKER-cell-7f3a',
  title: 'MARKER-title-7f3a',
  provider: 'MARKER-provider-message-7f3a',
};
const ALL = Object.values(M);

describe('privacy in telemetry', () => {
  const tracing = installMemoryTracing();
  const logged: string[] = [];
  const metricCalls: unknown[] = [];

  afterAll(() => tracing.uninstall());

  it('keeps every marker out of spans, metrics, logs and errors', async () => {
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => (logged.push(String(c)), true)) as never);
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => (logged.push(String(c)), true)) as never);
    const loggers = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((m) => jest.spyOn(Logger.prototype, m).mockImplementation(((...a: unknown[]) => void logged.push(a.map(String).join(' '))) as never));
    const errors: string[] = [];

    const fake = new FakeGoogle();
    const account = fake.addAccount({ email: M.address });
    const connections = new InMemoryConnections();
    const row = connections.add({ capabilities: ['mail_read', 'mail_send', 'mail_modify', 'calendar_read', 'calendar_write', 'docs_read', 'docs_write'], accountEmail: M.address, label: M.title });
    const metrics = { add: (...a: unknown[]) => void metricCalls.push(a), record: (...a: unknown[]) => void metricCalls.push(a) } as unknown as AppMetricsService;
    const http = new GoogleHttp(fake, metrics, { sleep: async () => undefined, random: () => 0.5 });
    const registry = new CapabilityProviderRegistry();
    registry.register(new GoogleCapabilityProvider(http, { getAccessToken: async () => account.accessToken }));
    const hub = new CapabilityHub({ lookup: connections.lookup, providers: registry });
    const ctx = { connectionId: row.id, userId: row.userId };
    const attempt = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        errors.push(JSON.stringify(e instanceof CapabilityError ? e.toJSON() : { name: (e as Error).name }));
        errors.push(String((e as Error).message));
      }
    };

    account.addMessage({ subject: M.subject, from: `X <${M.address}>`, text: M.body, attachments: [{ filename: M.file, bytes: Buffer.from(M.body) }] });
    const mail = hub.mail(ctx);
    const found = await mail.search({ text: M.query, from: M.address, subject: M.subject });
    await mail.search({});
    const full = await mail.get(account.messages[0]!.id, { body: 'text' });
    await mail.getAttachment(full.id, full.attachments[0]!.id);
    await mail.send({ to: [{ address: M.address, name: M.title }], subject: M.subject, text: M.body, attachments: [{ filename: M.file, contentType: 'text/plain', bytes: Buffer.from(M.body) }] });
    await mail.createDraft({ to: [{ address: M.address }], subject: M.subject, text: M.body });
    await mail.modify(full.id, { read: true });
    await mail.listLabels();
    const cal = hub.calendar(ctx);
    const ev = await cal.createEvent({ title: M.title, description: M.body, location: M.address, start: '2026-03-02T12:00:00Z', end: '2026-03-02T13:00:00Z', attendees: [{ address: M.address }] });
    await cal.listEvents({ from: '2026-03-01T00:00:00Z', to: '2026-03-31T00:00:00Z', text: M.query });
    await cal.updateEvent(ev.id, { title: M.title });
    await cal.deleteEvent(ev.id, { notifyAttendees: false });
    const docs = hub.documents(ctx);
    const sheet = await docs.createSpreadsheet({ title: M.file, headers: [M.cell] });
    await docs.appendRows(sheet.id, undefined, [[M.cell, M.body]]);
    await docs.readSheet(sheet.id, {});
    const doc = await docs.createDocument({ title: M.file, text: M.body });
    await docs.readDocument(doc.id);
    await docs.searchFiles({ text: M.query });
    await docs.uploadFile({ name: M.file, contentType: 'application/pdf', bytes: Buffer.from(M.body) });

    // failures, with a marker in Google's own error text
    for (const [status, times] of [[400, 1], [403, 1], [404, 1], [429, 3], [500, 3]] as const) {
      fake.failNext('labels$', { status, body: { error: { message: M.provider, status: 'X', errors: [{ reason: 'forbidden', message: M.provider }] } } }, times);
      await attempt(mail.listLabels());
    }
    fake.failNext('messages/send', { status: 503, body: { error: { message: M.provider } } });
    await attempt(mail.send({ to: [{ address: M.address }], subject: M.subject, text: M.body }));
    await attempt(mail.get('does-not-exist', { body: 'text' }));
    await attempt(mail.send({ to: [{ address: `${M.address}\r\nBcc: x@example.test` }], subject: M.subject, text: M.body }));
    expect(found.items).toHaveLength(0); // nothing matches the marker query: that is fine, the point is where the words travel

    out.mockRestore();
    err.mockRestore();
    loggers.forEach((l) => l.mockRestore());

    const spans = tracing.spans();
    expect(spans.length).toBeGreaterThan(20);
    // What IS recorded: the operation, the connection, sizes, attempts and the status.
    const list = spans.find((s) => s.name === 'google gmail.messages.list')!;
    expect(list.attributes).toMatchObject({ 'connection.id': row.id, 'google.service': 'gmail', 'google.operation': 'messages.list', 'http.response.status_code': 200 });
    expect(typeof list.attributes['http.response.body.size']).toBe('number');
    const post = spans.find((s) => s.name === 'google gmail.messages.send')!;
    expect(typeof post.attributes['http.request.body.size']).toBe('number');
    expect(spans.some((s) => s.attributes['error.code'] === 'RATE_LIMITED')).toBe(true);
    expect(metricCalls.length).toBeGreaterThan(20);
    expect(metricCalls.some((m) => (m as unknown[])[0] === 'googleRequests')).toBe(true);

    const surfaces: Record<string, string> = {
      spans: spans.map(spanText).join('\n'),
      metrics: JSON.stringify(metricCalls),
      logs: logged.join('\n'),
      errors: errors.join('\n'),
    };
    for (const [name, text] of Object.entries(surfaces)) for (const marker of ALL) expect({ surface: name, leaked: text.includes(marker) }).toEqual({ surface: name, leaked: false });
    // The span names and attributes name no URL: ids and search words travel in URLs.
    for (const s of spans) for (const v of Object.values(s.attributes)) expect(String(v)).not.toMatch(/^https?:\/\//);
    // The error vocabulary is closed.
    const codes: CapabilityErrorCode[] = ['NOT_FOUND', 'PERMISSION_MISSING', 'RATE_LIMITED', 'PROVIDER_ERROR', 'INVALID_INPUT'];
    for (const e of errors.filter((x) => x.startsWith('{'))) expect(codes).toContain(JSON.parse(e).code);
  });
});
